import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import type { GraphOutput } from "../types/graph-output.type";
import {
  SPAWN_TIMEOUT_MS,
  compile,
  installPackage,
  linkDependencies,
  readGraph,
  runBin,
  type Run,
} from "./test-support/installed-cli";

/**
 * `nest-graph-inspector export` finding the root module by itself, run as a
 * user runs it: the package compiled from these sources into a temporary
 * workspace's node_modules, and its bin started with `node` in projects laid
 * out as `nest build`, SWC, webpack and a Nest CLI monorepo leave them.
 *
 * Every run is watched for the application starting. main.ts writes
 * `bootstrap` to a log as it runs, every module's constructor writes its name,
 * and a preload in NODE_OPTIONS makes any `listen()` in the process write to a
 * log of its own and throw — so a run that loaded main.ts, or anything that
 * listens, cannot pass.
 */

/** Leaves a trace of the application's own code running, across processes. */
const MARKER = `import { appendFileSync } from "node:fs";

export function markRan(what: string): void {
  const log = process.env.FIXTURE_RAN_LOG;
  if (log) {
    appendFileSync(log, what + "\\n");
  }
}
`;

/** Refuses to listen, and says it was asked to: preloaded into every export. */
const LISTEN_PROBE = `"use strict";
const { appendFileSync } = require("node:fs");
const net = require("node:net");

net.Server.prototype.listen = function listen() {
  const log = process.env.FIXTURE_LISTEN_LOG;
  if (log) {
    appendFileSync(log, "listen in " + process.pid + "\\n");
  }
  throw new Error("listen-probe: an export must not listen");
};
`;

/**
 * A TypeScript loader for --require, standing in for ts-node: each .ts file
 * is compiled as it is required, with the decorator metadata Nest reads.
 */
const TS_LOADER = `"use strict";
const { readFileSync } = require("node:fs");
const ts = require("typescript");

require.extensions[".ts"] = function compileTypeScript(module, filename) {
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      esModuleInterop: true,
    },
  });
  module._compile(outputText, filename);
};
`;

/**
 * A module an older build left behind, which the export must never load:
 * loading it records itself, so a run that takes it cannot pass.
 */
const STALE_MODULE = `"use strict";
const { appendFileSync } = require("node:fs");
if (process.env.FIXTURE_RAN_LOG) {
  appendFileSync(process.env.FIXTURE_RAN_LOG, "stale module loaded\\n");
}
exports.AppModule = class AppModule {};
`;

/** What webpack or rspack makes of main.ts: one file that starts the application as it loads. */
const BUNDLE = `"use strict";
const { appendFileSync } = require("node:fs");
if (process.env.FIXTURE_RAN_LOG) {
  appendFileSync(process.env.FIXTURE_RAN_LOG, "bootstrap\\n");
}
const _nestjs_core__WEBPACK_IMPORTED_MODULE_0__ = require("@nestjs/core");
class BundledRootModule {}
async function bootstrap() {
  const app = await _nestjs_core__WEBPACK_IMPORTED_MODULE_0__.NestFactory.create(BundledRootModule);
  await app.listen(3000);
}
void bootstrap();
`;

/** A module whose constructor would mark it, importing `imports` — `[name, from]` pairs. */
function moduleSource(
  name: string,
  imports: readonly (readonly [string, string])[] = [],
  marker = "./marker",
): string {
  return `import { Module } from "@nestjs/common";
import { markRan } from "${marker}";
${imports.map(([module, from]) => `import { ${module} } from "${from}";`).join("\n")}

@Module({ imports: [${imports.map(([module]) => module).join(", ")}] })
export class ${name} {
  constructor() {
    markRan("${name}.constructor");
  }
}
`;
}

/** main.ts, booting `root` from `from`. */
function mainSource(
  root: string,
  from: string,
  { marker = "./marker", boot = `NestFactory.create(${root})` } = {},
): string {
  return `import { NestFactory } from "@nestjs/core";
import { ${root} } from "${from}";
import { markRan } from "${marker}";

async function bootstrap(): Promise<void> {
  markRan("bootstrap");
  const app = await ${boot};
  await app.listen(3000);
}

void bootstrap();
`;
}

const TSCONFIG = (compilerOptions: Record<string, unknown> = {}) =>
  JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "commonjs",
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
      strict: true,
      skipLibCheck: true,
      ...compilerOptions,
    },
  });

type ExportRun = Run & {
  graph: GraphOutput | undefined;
  /** What the application's own code recorded running; undefined when nothing ran. */
  ranLog: string | undefined;
  /** Every listen() attempted; undefined when there was none. */
  listenLog: string | undefined;
};

let workDir: string;
let bin: string;
let listenProbe: string;
let runCount = 0;

/** A project under the workspace: `files` written, `builds` compiled the way tsc lays them out. */
function writeProject(
  name: string,
  files: Record<string, string>,
  builds: readonly { rootDir: string; outDir: string; files: readonly string[] }[] = [],
): void {
  const projectDir = join(workDir, "projects", name);
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(projectDir, path)), { recursive: true });
    writeFileSync(join(projectDir, path), content);
  };

  write("package.json", JSON.stringify({ name, private: true }));
  for (const [path, content] of Object.entries(files)) {
    write(path, content);
  }

  for (const build of builds) {
    for (const file of build.files) {
      const { outputText, diagnostics } = ts.transpileModule(files[file] ?? "", {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      });
      if (diagnostics?.length) {
        throw new Error(`${name}/${file} does not compile`);
      }

      write(
        join(build.outDir, relative(build.rootDir, file)).replace(/\.ts$/, ".js"),
        outputText,
      );
    }
  }
}

/**
 * Builds a project's application with tsc itself, from the tsconfig `nest
 * build` would run it with: what lands where is the compiler's doing, and any
 * diagnostic fails the fixture.
 */
function buildWithTsc(project: string, tsconfig: string): void {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(workDir, "projects", project, tsconfig),
    undefined,
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!config || config.errors.length) {
    throw new Error(`${project}/${tsconfig} cannot be read`);
  }

  compile(config.fileNames, config.options);
}

/** `nest-graph-inspector export` in a project, as a user's shell runs it. */
async function exportIn(project: string, args: readonly string[] = []): Promise<ExportRun> {
  const runDir = join(workDir, "runs", String(++runCount));
  mkdirSync(runDir, { recursive: true });
  const out = join(runDir, "graph.json");
  const ranLog = join(runDir, "ran.log");
  const listenLog = join(runDir, "listen.log");
  const readIfThere = (path: string) =>
    existsSync(path) ? readFileSync(path, "utf8") : undefined;

  const result = await runBin(bin, ["export", "--out", out, ...args], {
    cwd: join(workDir, "projects", project),
    env: {
      FIXTURE_RAN_LOG: ranLog,
      FIXTURE_LISTEN_LOG: listenLog,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${JSON.stringify(listenProbe)}`]
        .filter(Boolean)
        .join(" "),
    },
  });

  return {
    ...result,
    graph: existsSync(out) ? readGraph(out) : undefined,
    ranLog: readIfThere(ranLog),
    listenLog: readIfThere(listenLog),
  };
}

/**
 * Requires a run to have ended with `status` having run none of the
 * application — no bootstrap, constructor or hook — and with nothing having
 * listened. Compared as one object holding stderr too, so a failure shows
 * why.
 */
function expectOutcome(result: ExportRun, status: number): void {
  const outcome = {
    status: result.status,
    stderr: result.stderr,
    ranLog: result.ranLog,
    listenLog: result.listenLog,
  };

  expect(outcome).toEqual({
    ...outcome,
    status,
    ranLog: undefined,
    listenLog: undefined,
  });
}

/** An export that succeeded, with `root` as the graph's root and the modules given present or absent. */
function expectExported(
  result: ExportRun,
  root: string,
  modules: { present: readonly string[]; absent?: readonly string[] },
): void {
  expectOutcome(result, 0);
  expect(result.graph?.root).toBe(root);
  const names = Object.keys(result.graph?.modules ?? {});
  for (const present of [root, ...modules.present]) {
    expect(names).toContain(present);
  }
  for (const absent of modules.absent ?? []) {
    expect(names).not.toContain(absent);
  }
}

/** An export refused, or failed, with `message`, having run nothing. */
function expectRefused(result: ExportRun, status: number, message: string): void {
  expectOutcome(result, status);
  expect(result.stderr).toContain(message);
  expect(result.graph).toBeUndefined();
}

describe("nest-graph-inspector export finds the root module (e2e)", () => {
  beforeAll(() => {
    workDir = realpathSync(
      mkdtempSync(join(tmpdir(), "nest-graph-inspector-detection-e2e-")),
    );
    const nodeModules = join(workDir, "node_modules");
    // typescript for the fixtures' own --require loader.
    linkDependencies(nodeModules, ["typescript"]);
    bin = join(installPackage(nodeModules), "dist/cli/bin.js");
    listenProbe = join(workDir, "listen-probe.cjs");
    writeFileSync(listenProbe, LISTEN_PROBE);

    const srcBuild = (files: Record<string, string>) => [
      {
        rootDir: "src",
        outDir: "dist",
        files: Object.keys(files).filter((file) => file.startsWith("src/")),
      },
    ];

    // E1: the root module is not called AppModule, nor in app.module.ts.
    const rootNamed = {
      "tsconfig.json": TSCONFIG({ rootDir: "src", outDir: "dist" }),
      "src/marker.ts": MARKER,
      "src/child.module.ts": moduleSource("ChildModule"),
      "src/root.module.ts": moduleSource("RootModule", [["ChildModule", "./child.module"]]),
      "src/main.ts": mainSource("RootModule", "./root.module"),
    };
    writeProject("root-named", rootNamed, srcBuild(rootNamed));

    // E2: two modules in one file, main.ts booting one of them.
    const multiModule = {
      "tsconfig.json": TSCONFIG({ rootDir: "src", outDir: "dist" }),
      "src/marker.ts": MARKER,
      "src/main.module.ts": `${moduleSource("HelperModule")}
@Module({ imports: [HelperModule] })
export class MainModule {
  constructor() {
    markRan("MainModule.constructor");
  }
}
`,
      "src/main.ts": mainSource("MainModule", "./main.module"),
    };
    writeProject("multi-module", multiModule, srcBuild(multiModule));

    // E3: nest-cli.json names another entry file, in another source root.
    const customEntry = {
      "nest-cli.json": JSON.stringify({ sourceRoot: "backend", entryFile: "server" }),
      "tsconfig.json": TSCONFIG({ rootDir: "backend", outDir: "dist" }),
      "backend/marker.ts": MARKER,
      "backend/status.module.ts": moduleSource("StatusModule"),
      "backend/backend.module.ts": moduleSource("BackendModule", [
        ["StatusModule", "./status.module"],
      ]),
      "backend/server.ts": mainSource("BackendModule", "./backend.module"),
    };
    writeProject("custom-entry", customEntry, [
      {
        rootDir: "backend",
        outDir: "dist",
        files: Object.keys(customEntry).filter((file) => file.startsWith("backend/")),
      },
    ]);

    // E4: a Nest CLI monorepo — two applications and a library, built by
    // tsc into dist/apps/<app>, the project being tsc's root directory. The
    // applications import the library by a relative path: at runtime there
    // is no tsconfig-paths.
    const shared = "../../../libs/shared/src";
    const appProject = (app: string) => ({
      type: "application",
      root: `apps/${app}`,
      entryFile: "main",
      sourceRoot: `apps/${app}/src`,
      compilerOptions: { tsConfigPath: `apps/${app}/tsconfig.app.json` },
    });
    const monorepoNestCli = {
      $schema: "https://json.schemastore.org/nest-cli",
      collection: "@nestjs/schematics",
      monorepo: true,
      root: "apps/api",
      sourceRoot: "apps/api/src",
      compilerOptions: {
        builder: "tsc",
        tsConfigPath: "apps/api/tsconfig.app.json",
      },
      projects: {
        api: appProject("api"),
        worker: appProject("worker"),
        shared: {
          type: "library",
          root: "libs/shared",
          entryFile: "index",
          sourceRoot: "libs/shared/src",
          compilerOptions: { tsConfigPath: "libs/shared/tsconfig.lib.json" },
        },
      },
    };
    const monorepo: Record<string, string> = {
      "nest-cli.json": JSON.stringify(monorepoNestCli),
      "tsconfig.json": TSCONFIG(),
      "libs/shared/src/marker.ts": MARKER,
      "libs/shared/src/shared.module.ts": moduleSource("SharedModule"),
      "libs/shared/tsconfig.lib.json": JSON.stringify({
        extends: "../../tsconfig.json",
        compilerOptions: { outDir: "../../dist/libs/shared" },
      }),
    };
    for (const [app, root] of [
      ["api", "ApiModule"],
      ["worker", "WorkerModule"],
    ] as const) {
      monorepo[`apps/${app}/tsconfig.app.json`] = JSON.stringify({
        extends: "../../tsconfig.json",
        compilerOptions: { outDir: `../../dist/apps/${app}` },
      });
      monorepo[`apps/${app}/src/${app}.module.ts`] = moduleSource(
        root,
        [["SharedModule", `${shared}/shared.module`]],
        `${shared}/marker`,
      );
      monorepo[`apps/${app}/src/main.ts`] = mainSource(root, `./${app}.module`, {
        marker: `${shared}/marker`,
      });
    }
    const monorepoBuilds = (files: Record<string, string>) =>
      ["api", "worker"].map((app) => ({
        rootDir: "",
        outDir: `dist/apps/${app}`,
        files: Object.keys(files).filter(
          (file) =>
            file.endsWith(".ts") &&
            (file.startsWith(`apps/${app}/`) || file.startsWith("libs/")),
        ),
      }));
    writeProject("monorepo", monorepo, monorepoBuilds(monorepo));

    // E4, naming no builder: the Nest CLI builds it with tsc, as above.
    const monorepoNoBuilder = {
      ...monorepo,
      "nest-cli.json": JSON.stringify({
        ...monorepoNestCli,
        compilerOptions: { tsConfigPath: "apps/api/tsconfig.app.json" },
      }),
    };
    writeProject("monorepo-no-builder", monorepoNoBuilder, monorepoBuilds(monorepoNoBuilder));

    // E4, by convention: api's root module is AppModule in app.module.ts,
    // which nest build leaves as an app.module.js.
    const monorepoConvention: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(monorepo).filter(([file]) => file !== "apps/api/src/api.module.ts"),
      ),
      "apps/api/src/app.module.ts": moduleSource(
        "AppModule",
        [["SharedModule", `${shared}/shared.module`]],
        `${shared}/marker`,
      ),
      "apps/api/src/main.ts": mainSource("AppModule", "./app.module", {
        marker: `${shared}/marker`,
      }),
    };
    writeProject("monorepo-convention", monorepoConvention, monorepoBuilds(monorepoConvention));

    // E4, one outDir: api and worker built with the project's own tsconfig
    // into dist/, where only api has an app.module.js.
    const application = (app: string) => ({
      type: "application",
      root: `apps/${app}`,
      entryFile: "main",
      sourceRoot: `apps/${app}/src`,
    });
    const sharedOutDir = {
      "nest-cli.json": JSON.stringify({
        monorepo: true,
        root: "apps/api",
        sourceRoot: "apps/api/src",
        compilerOptions: { builder: "tsc" },
        projects: { api: application("api"), worker: application("worker") },
      }),
      "tsconfig.json": TSCONFIG({ rootDir: ".", outDir: "dist" }),
      "apps/api/src/marker.ts": MARKER,
      "apps/api/src/app.module.ts": moduleSource("AppModule"),
      "apps/api/src/main.ts": mainSource("AppModule", "./app.module"),
      "apps/worker/src/marker.ts": MARKER,
      "apps/worker/src/worker.module.ts": moduleSource("WorkerModule"),
      "apps/worker/src/main.ts": mainSource("WorkerModule", "./worker.module"),
    };
    writeProject("monorepo-shared-out-dir", sharedOutDir, [
      {
        rootDir: "",
        outDir: "dist",
        files: Object.keys(sharedOutDir).filter((file) => file.endsWith(".ts")),
      },
    ]);

    // E4, worker's own layout: rootDir apps/, an outDir of its own, so tsc
    // writes dist/worker/worker/src/. An app.module.js an older build left
    // flattened in that outDir must never load — it says so if it does.
    const ownLayout = {
      "nest-cli.json": JSON.stringify({
        monorepo: true,
        root: "apps/api",
        sourceRoot: "apps/api/src",
        compilerOptions: { builder: "tsc", tsConfigPath: "apps/api/tsconfig.app.json" },
        projects: {
          api: { ...application("api"), compilerOptions: { tsConfigPath: "apps/api/tsconfig.app.json" } },
          worker: {
            ...application("worker"),
            compilerOptions: { tsConfigPath: "apps/worker/tsconfig.app.json" },
          },
        },
      }),
      "tsconfig.json": TSCONFIG(),
      "apps/api/tsconfig.app.json": JSON.stringify({
        extends: "../../tsconfig.json",
        compilerOptions: { outDir: "../../dist/api" },
      }),
      "apps/worker/tsconfig.app.json": JSON.stringify({
        extends: "../../tsconfig.json",
        compilerOptions: { rootDir: "..", outDir: "../../dist/worker" },
      }),
      "apps/worker/src/marker.ts": MARKER,
      "apps/worker/src/worker.module.ts": moduleSource("WorkerModule"),
      "apps/worker/src/main.ts": mainSource("WorkerModule", "./worker.module"),
      "dist/worker/app.module.js": STALE_MODULE,
    };
    writeProject("monorepo-own-layout", ownLayout, [
      {
        rootDir: "apps",
        outDir: "dist/worker",
        files: Object.keys(ownLayout).filter((file) => file.startsWith("apps/worker/src/")),
      },
    ]);

    // E11: built by SWC into the outDir its builder options name, not the
    // tsconfig's — dist/ holds an older tsc build that must not be taken.
    const swcOutDir = {
      "nest-cli.json": JSON.stringify({
        compilerOptions: { builder: { type: "swc", options: { outDir: "build" } } },
      }),
      "tsconfig.json": TSCONFIG({ outDir: "dist" }),
      "src/marker.ts": MARKER,
      "src/child.module.ts": moduleSource("ChildModule"),
      "src/swc-root.module.ts": moduleSource("SwcRootModule", [["ChildModule", "./child.module"]]),
      "src/main.ts": mainSource("SwcRootModule", "./swc-root.module"),
      "dist/swc-root.module.js": STALE_MODULE,
    };
    writeProject("swc-out-dir", swcOutDir, [
      {
        rootDir: "src",
        outDir: "build",
        files: Object.keys(swcOutDir).filter((file) => file.startsWith("src/")),
      },
    ]);

    // E5: built by webpack or rspack into one main.js that starts the
    // application; nothing else is in dist.
    const bundled = {
      "tsconfig.json": TSCONFIG({ rootDir: "src", outDir: "dist" }),
      "ts-loader.cjs": TS_LOADER,
      "src/marker.ts": MARKER,
      "src/feature.module.ts": moduleSource("FeatureModule"),
      "src/bundled-root.module.ts": moduleSource("BundledRootModule", [
        ["FeatureModule", "./feature.module"],
      ]),
      "src/main.ts": mainSource("BundledRootModule", "./bundled-root.module"),
      "dist/main.js": BUNDLE,
    };
    writeProject("bundled-webpack", {
      ...bundled,
      "nest-cli.json": JSON.stringify({ compilerOptions: { builder: "webpack" } }),
    });
    writeProject("bundled-rspack", {
      ...bundled,
      "nest-cli.json": JSON.stringify({
        compilerOptions: {
          builder: { type: "rspack", options: { configPath: "rspack.config.js" } },
        },
      }),
      "rspack.config.js": 'module.exports = { target: "node" };\n',
    });

    // E6: not built at all. no-loader.cjs is a --require that registers
    // nothing, which leaves the TypeScript to Node.
    writeProject("unbuilt", {
      "tsconfig.json": TSCONFIG({ rootDir: "src", outDir: "dist" }),
      "ts-loader.cjs": TS_LOADER,
      "no-loader.cjs": '"use strict";\n',
      "src/marker.ts": MARKER,
      "src/child.module.ts": moduleSource("ChildModule"),
      "src/unbuilt-root.module.ts": moduleSource("UnbuiltRootModule", [
        ["ChildModule", "./child.module"],
      ]),
      "src/main.ts": mainSource("UnbuiltRootModule", "./unbuilt-root.module"),
    });

    // E7: one file — the root module declared in main.ts, as nest new
    // --minimal writes it.
    const oneFile = {
      "tsconfig.json": TSCONFIG({ rootDir: "src", outDir: "dist" }),
      "ts-loader.cjs": TS_LOADER,
      "src/marker.ts": MARKER,
      "src/main.ts": `import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { markRan } from "./marker";

@Module({})
export class AppModule {}

async function bootstrap(): Promise<void> {
  markRan("bootstrap");
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}

void bootstrap();
`,
    };
    writeProject("one-file", oneFile, srcBuild(oneFile));

    // E8: the project the export has always handled, and one whose main.ts
    // boots another module than the app.module.js it finds by convention.
    const standard = {
      "tsconfig.json": TSCONFIG({ rootDir: "src", outDir: "dist" }),
      "src/marker.ts": MARKER,
      "src/child.module.ts": moduleSource("ChildModule"),
      "src/app.module.ts": `console.log("app.module loaded");\n${moduleSource("AppModule", [
        ["ChildModule", "./child.module"],
      ])}`,
      "src/main.ts": mainSource("AppModule", "./app.module"),
    };
    writeProject("standard", standard, srcBuild(standard));
    const conventionWins = {
      ...standard,
      "src/other-root.module.ts": `console.log("other-root.module loaded");\n${moduleSource("OtherRootModule")}`,
      "src/main.ts": mainSource("OtherRootModule", "./other-root.module"),
    };
    writeProject("convention-wins", conventionWins, srcBuild(conventionWins));

    // E9: main.ts boots two different root modules.
    const twoRoots = {
      "tsconfig.json": TSCONFIG({ rootDir: "src", outDir: "dist" }),
      "src/marker.ts": MARKER,
      "src/api.module.ts": moduleSource("ApiModule"),
      "src/worker.module.ts": moduleSource("WorkerModule"),
      "src/main.ts": `import { NestFactory } from "@nestjs/core";
import { ApiModule } from "./api.module";
import { WorkerModule } from "./worker.module";
import { markRan } from "./marker";

async function bootstrap(): Promise<void> {
  markRan("bootstrap");
  const worker = await NestFactory.createApplicationContext(WorkerModule);
  await worker.init();
  const api = await NestFactory.create(ApiModule);
  await api.listen(3000);
}

void bootstrap();
`,
    };
    writeProject("two-roots", twoRoots, srcBuild(twoRoots));

    // E10: main.ts also calls create() on a NestFactory of its own, on a
    // parameter that shadows the import, on a let alias assigned something
    // else, and through a require() of its own; none of them boots anything.
    const ownFactory = {
      "tsconfig.json": TSCONFIG({ rootDir: "src", outDir: "dist" }),
      "src/marker.ts": MARKER,
      "src/helper.module.ts": moduleSource("HelperModule"),
      "src/root.module.ts": moduleSource("RootModule"),
      "src/tools.ts": `export const tools = {
  NestFactory: { create: (module: unknown): unknown => module },
};
`,
      "src/main.ts": `import { NestFactory } from "@nestjs/core";
import { HelperModule } from "./helper.module";
import { markRan } from "./marker";
import { RootModule } from "./root.module";
import { tools } from "./tools";

export function warmUp(NestFactory: typeof tools.NestFactory): void {
  NestFactory.create(HelperModule);
}

export function warmUpThrough(require: (id: string) => typeof tools): void {
  require("@nestjs/core").NestFactory.create(HelperModule);
}

let Factory: typeof tools.NestFactory = NestFactory;
Factory = tools.NestFactory;

async function bootstrap(): Promise<void> {
  markRan("bootstrap");
  tools.NestFactory.create(HelperModule);
  warmUp(tools.NestFactory);
  warmUpThrough(() => tools);
  Factory.create(HelperModule);
  const app = await NestFactory.create(RootModule);
  await app.listen(3000);
}

void bootstrap();
`,
    };
    writeProject("own-factory", ownFactory, srcBuild(ownFactory));

    // E12: bootstrap() boots a local RootModule, which shadows the import of
    // ApiModule under that name: the local's WorkerModule is the root.
    const localRoot = {
      "tsconfig.json": TSCONFIG({ rootDir: "src", outDir: "dist" }),
      "src/marker.ts": MARKER,
      "src/api.module.ts": moduleSource("ApiModule"),
      "src/worker.module.ts": moduleSource("WorkerModule"),
      "src/main.ts": `import { NestFactory } from "@nestjs/core";
import { ApiModule as RootModule } from "./api.module";
import { markRan } from "./marker";
import { WorkerModule } from "./worker.module";

export const api = RootModule;

async function bootstrap(): Promise<void> {
  markRan("bootstrap");
  const RootModule = WorkerModule;
  const app = await NestFactory.create(RootModule);
  await app.listen(3000);
}

void bootstrap();
`,
    };
    writeProject("local-root", localRoot, srcBuild(localRoot));

    // E13: the convention's AppModule, which main.ts boots through a barrel
    // that exports it as RootModule — and also star-exports another
    // RootModule, which the explicit export hides.
    const barrelConst = {
      "tsconfig.json": TSCONFIG({ rootDir: "src", outDir: "dist" }),
      "src/marker.ts": MARKER,
      "src/app.module.ts": moduleSource("AppModule"),
      "src/modules/other.ts": moduleSource("RootModule", [], "../marker"),
      "src/modules/index.ts": `import { AppModule } from "../app.module";

export * from "./other";
export const RootModule = AppModule;
`,
      "src/main.ts": mainSource("RootModule", "./modules"),
    };
    writeProject("barrel-const", barrelConst, srcBuild(barrelConst));

    // E14: built by SWC both as Nest CLI 12 lays it out and as Nest CLI 11
    // does: one of the two is stale, and which cannot be told.
    const swcBoth = {
      "nest-cli.json": JSON.stringify({
        sourceRoot: "apps/api/src",
        compilerOptions: { builder: "swc" },
      }),
      "tsconfig.json": TSCONFIG({ outDir: "dist" }),
      "ts-loader.cjs": TS_LOADER,
      "apps/api/src/marker.ts": MARKER,
      "apps/api/src/swc-root.module.ts": moduleSource("SwcRootModule"),
      "apps/api/src/main.ts": mainSource("SwcRootModule", "./swc-root.module"),
    };
    const apiSources = Object.keys(swcBoth).filter((file) => file.startsWith("apps/api/src/"));
    writeProject("swc-both-layouts", swcBoth, [
      { rootDir: "", outDir: "dist", files: apiSources },
      { rootDir: "apps", outDir: "dist", files: apiSources },
    ]);

    // E15: a tsconfig with an outDir and no rootDir, built by TypeScript 5,
    // which took the sources' directory for its root, and again by
    // TypeScript 6, which takes the tsconfig's: dist/ and dist/src/ both
    // hold the root module, and one of them is stale.
    const inferredRoots = {
      "tsconfig.json": TSCONFIG({ outDir: "dist" }),
      "ts-loader.cjs": TS_LOADER,
      "src/marker.ts": MARKER,
      "src/inferred-root.module.ts": moduleSource("InferredRootModule"),
      "src/main.ts": mainSource("InferredRootModule", "./inferred-root.module"),
    };
    const inferredSources = Object.keys(inferredRoots).filter((file) => file.startsWith("src/"));
    writeProject("tsc-inferred-roots", inferredRoots, [
      { rootDir: "src", outDir: "dist", files: inferredSources },
      { rootDir: "", outDir: "dist", files: inferredSources },
    ]);

    // E16: main.ts boots a root module it computes at runtime, then the one
    // it imports: the import decides, and the other boot is said to be
    // passed over.
    const skippedBoot = {
      "tsconfig.json": TSCONFIG({ rootDir: "src", outDir: "dist" }),
      "src/marker.ts": MARKER,
      "src/root.module.ts": moduleSource("RootModule"),
      "src/root-for.ts": `import { RootModule } from "./root.module";

export function rootFor(app: string | undefined): typeof RootModule {
  void app;
  return RootModule;
}
`,
      "src/main.ts": `import { NestFactory } from "@nestjs/core";
import { markRan } from "./marker";
import { RootModule } from "./root.module";
import { rootFor } from "./root-for";

async function bootstrap(): Promise<void> {
  markRan("bootstrap");
  const context = await NestFactory.createApplicationContext(rootFor(process.env.APP));
  await context.close();
  const app = await NestFactory.create(RootModule);
  await app.listen(3000);
}

void bootstrap();
`,
    };
    writeProject("skipped-boot", skippedBoot, srcBuild(skippedBoot));

    // E17: main.ts boots two root modules, each through a const of its own
    // name, which --module can name.
    const aliasRoots = {
      ...twoRoots,
      "src/main.ts": `import { NestFactory } from "@nestjs/core";
import { ApiModule } from "./api.module";
import { markRan } from "./marker";
import { WorkerModule } from "./worker.module";

const Api = ApiModule;
const Worker = WorkerModule;

async function bootstrap(): Promise<void> {
  markRan("bootstrap");
  const worker = await NestFactory.createApplicationContext(Worker);
  await worker.init();
  const api = await NestFactory.create(Api);
  await api.listen(3000);
}

void bootstrap();
`,
    };
    writeProject("alias-roots", aliasRoots, srcBuild(aliasRoots));

    // E18: an .mts main.ts under NodeNext — an ES module in a CommonJS
    // package — that takes its root module with import = require().
    const mtsRequire = {
      "tsconfig.json": TSCONFIG({
        module: "nodenext",
        moduleResolution: "nodenext",
        rootDir: "src",
        outDir: "dist",
      }),
      "src/marker.ts": MARKER,
      "src/child.module.ts": moduleSource("ChildModule"),
      "src/root.module.ts": moduleSource("RootModule", [["ChildModule", "./child.module"]]),
      "src/main.mts": `import { NestFactory } from "@nestjs/core";
import { markRan } from "./marker.js";
import modules = require("./root.module");

async function bootstrap(): Promise<void> {
  markRan("bootstrap");
  const app = await NestFactory.create(modules.RootModule);
  await app.listen(3000);
}

void bootstrap();
`,
    };
    writeProject("mts-require", mtsRequire, [
      {
        rootDir: "src",
        outDir: "dist",
        files: ["src/marker.ts", "src/child.module.ts", "src/root.module.ts"],
      },
    ]);

    // E19: the convention's AppModule, while main.ts boots RootModule through
    // a barrel that star-exports it — beside a default-exported function of
    // that name, which exports no RootModule.
    const barrelDefaultFunction = {
      "tsconfig.json": TSCONFIG({ rootDir: "src", outDir: "dist" }),
      "src/marker.ts": MARKER,
      "src/app.module.ts": moduleSource("AppModule"),
      "src/modules/root.module.ts": moduleSource("RootModule", [], "../marker"),
      "src/modules/index.ts": `export * from "./root.module";

export default function RootModule(): void {}
`,
      "src/main.ts": mainSource("RootModule", "./modules"),
    };
    writeProject(
      "barrel-default-function",
      barrelDefaultFunction,
      srcBuild(barrelDefaultFunction),
    );

    // E4, one source path in each application: api and worker each boot
    // RootModule from their own root.module.ts, and each builds with a
    // tsconfig.app.json of its own — its sources, rootDir src/, outDir the
    // project's dist/ — so tsc writes either to dist/root.module.js. Only
    // api has been built, by tsc itself.
    const ownTsConfig = (app: string) => ({
      ...application(app),
      compilerOptions: { tsConfigPath: `apps/${app}/tsconfig.app.json` },
    });
    const appTsConfig = (rootDir: string) =>
      JSON.stringify({
        extends: "../../tsconfig.json",
        compilerOptions: { rootDir, outDir: "../../dist", types: ["node"] },
        include: ["src/**/*"],
      });
    const sameRootPath: Record<string, string> = {
      "nest-cli.json": JSON.stringify({
        monorepo: true,
        root: "apps/api",
        sourceRoot: "apps/api/src",
        compilerOptions: { builder: "tsc", tsConfigPath: "apps/api/tsconfig.app.json" },
        projects: { api: ownTsConfig("api"), worker: ownTsConfig("worker") },
      }),
      "tsconfig.json": TSCONFIG(),
      "ts-loader.cjs": TS_LOADER,
    };
    for (const [app, feature] of [
      ["api", "ApiFeatureModule"],
      ["worker", "WorkerFeatureModule"],
    ] as const) {
      sameRootPath[`apps/${app}/tsconfig.app.json`] = appTsConfig("src");
      sameRootPath[`apps/${app}/src/marker.ts`] = MARKER;
      sameRootPath[`apps/${app}/src/feature.module.ts`] = moduleSource(feature);
      sameRootPath[`apps/${app}/src/root.module.ts`] = moduleSource("RootModule", [
        [feature, "./feature.module"],
      ]);
      sameRootPath[`apps/${app}/src/main.ts`] = mainSource("RootModule", "./root.module");
    }
    writeProject("monorepo-same-root-path", sameRootPath);
    buildWithTsc("monorepo-same-root-path", "apps/api/tsconfig.app.json");

    // E4, the same output path from sources at different paths: api's
    // rootDir is apps/api, worker's apps/worker/src, so api's
    // src/root.module.ts and worker's src/src/root.module.ts both become
    // dist/src/root.module.js. Only api has been built, by tsc itself.
    const rootDirs: Record<string, string> = {
      "nest-cli.json": JSON.stringify({
        monorepo: true,
        root: "apps/api",
        sourceRoot: "apps/api/src",
        compilerOptions: { builder: "tsc", tsConfigPath: "apps/api/tsconfig.app.json" },
        projects: { api: ownTsConfig("api"), worker: ownTsConfig("worker") },
      }),
      "tsconfig.json": TSCONFIG(),
      "ts-loader.cjs": TS_LOADER,
      "apps/api/tsconfig.app.json": appTsConfig("."),
      "apps/api/src/marker.ts": MARKER,
      "apps/api/src/feature.module.ts": moduleSource("ApiFeatureModule"),
      "apps/api/src/root.module.ts": moduleSource("RootModule", [
        ["ApiFeatureModule", "./feature.module"],
      ]),
      "apps/api/src/main.ts": mainSource("RootModule", "./root.module"),
      "apps/worker/tsconfig.app.json": appTsConfig("src"),
      "apps/worker/src/marker.ts": MARKER,
      "apps/worker/src/src/feature.module.ts": moduleSource("WorkerFeatureModule", [], "../marker"),
      "apps/worker/src/src/root.module.ts": moduleSource(
        "RootModule",
        [["WorkerFeatureModule", "./feature.module"]],
        "../marker",
      ),
      "apps/worker/src/main.ts": mainSource("RootModule", "./src/root.module"),
    };
    writeProject("monorepo-root-dirs", rootDirs);
    buildWithTsc("monorepo-root-dirs", "apps/api/tsconfig.app.json");

    // E4, a tsc application beside a webpack one, both with a root.module.ts
    // at the top of their sources and dist/ as their outDir: only tsc writes
    // a dist/root.module.js — webpack writes one bundle — so it is api's.
    const bundledSibling: Record<string, string> = {
      "nest-cli.json": JSON.stringify({
        monorepo: true,
        root: "apps/api",
        sourceRoot: "apps/api/src",
        compilerOptions: { builder: "tsc", tsConfigPath: "apps/api/tsconfig.app.json" },
        projects: {
          api: ownTsConfig("api"),
          worker: {
            ...ownTsConfig("worker"),
            compilerOptions: { builder: "webpack", tsConfigPath: "apps/worker/tsconfig.app.json" },
          },
        },
      }),
      "tsconfig.json": TSCONFIG(),
      "dist/apps/worker/main.js": BUNDLE,
    };
    for (const [app, feature] of [
      ["api", "ApiFeatureModule"],
      ["worker", "WorkerFeatureModule"],
    ] as const) {
      bundledSibling[`apps/${app}/tsconfig.app.json`] = appTsConfig("src");
      bundledSibling[`apps/${app}/src/marker.ts`] = MARKER;
      bundledSibling[`apps/${app}/src/feature.module.ts`] = moduleSource(feature);
      bundledSibling[`apps/${app}/src/root.module.ts`] = moduleSource("RootModule", [
        [feature, "./feature.module"],
      ]);
      bundledSibling[`apps/${app}/src/main.ts`] = mainSource("RootModule", "./root.module");
    }
    writeProject("monorepo-bundled-sibling", bundledSibling);
    buildWithTsc("monorepo-bundled-sibling", "apps/api/tsconfig.app.json");

    // E4, --app's app.module.js in both SWC layouts: worker, the default
    // project, is built by SWC from src/ with rootDir ".", so Nest CLI 12
    // writes dist/src/ and Nest CLI 11 dist/. An older build left an
    // app.module.js in the first; api's tsc, rootDir apps/api/src, writes
    // its own AppModule to the second.
    const swcTwoLayouts: Record<string, string> = {
      "nest-cli.json": JSON.stringify({
        monorepo: true,
        root: "",
        sourceRoot: "src",
        compilerOptions: { builder: "swc", tsConfigPath: "tsconfig.json" },
        projects: {
          worker: {
            type: "application",
            root: "",
            sourceRoot: "src",
            compilerOptions: { builder: "swc", tsConfigPath: "tsconfig.json" },
          },
          api: {
            ...application("api"),
            compilerOptions: { builder: "tsc", tsConfigPath: "apps/api/tsconfig.app.json" },
          },
        },
      }),
      "tsconfig.json": TSCONFIG({ rootDir: ".", outDir: "dist", types: ["node"] }),
      "apps/api/tsconfig.app.json": JSON.stringify({
        extends: "../../tsconfig.json",
        compilerOptions: { rootDir: "src" },
        include: ["src/**/*"],
      }),
      "apps/api/src/marker.ts": MARKER,
      "apps/api/src/app.module.ts": moduleSource("AppModule"),
      "apps/api/src/main.ts": mainSource("AppModule", "./app.module"),
      "src/marker.ts": MARKER,
      "src/worker.module.ts": moduleSource("WorkerModule"),
      "src/main.ts": mainSource("WorkerModule", "./worker.module"),
      "dist/src/app.module.js": STALE_MODULE,
    };
    writeProject("monorepo-swc-two-layouts", swcTwoLayouts, [
      // Nest CLI 11's layout for worker's modules; its main.js is api's.
      { rootDir: "src", outDir: "dist", files: ["src/marker.ts", "src/worker.module.ts"] },
    ]);
    buildWithTsc("monorepo-swc-two-layouts", "apps/api/tsconfig.app.json");
  }, 180_000);

  afterAll(() => {
    // Unset when beforeAll failed before making it: that failure is the one
    // to report, not a second one here.
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("E1: exports a root module that is neither AppModule nor in app.module.ts", async () => {
    const result = await exportIn("root-named");

    expectExported(result, "RootModule", { present: ["ChildModule"] });
    expect(result.stderr).toContain(
      "nest-graph-inspector: entry dist/root.module.js (RootModule, from src/main.ts)\n",
    );
  }, SPAWN_TIMEOUT_MS);

  it("E2: exports the module main.ts boots from a file that exports two, or the one --module names", async () => {
    const [booted, chosen] = await Promise.all([
      exportIn("multi-module"),
      exportIn("multi-module", ["--module", "HelperModule"]),
    ]);

    expectExported(booted, "MainModule", { present: ["HelperModule"] });
    expectExported(chosen, "HelperModule", { present: [], absent: ["MainModule"] });
    expect(chosen.stderr).toContain(
      "nest-graph-inspector: entry dist/main.module.js (HelperModule, from src/main.ts)\n",
    );
  }, SPAWN_TIMEOUT_MS);

  it("E3: reads main.ts from the entryFile and sourceRoot nest-cli.json names", async () => {
    const result = await exportIn("custom-entry");

    expectExported(result, "BackendModule", { present: ["StatusModule"] });
    expect(result.stderr).toContain(
      "nest-graph-inspector: entry dist/backend.module.js (BackendModule, from backend/server.ts)\n",
    );
  }, SPAWN_TIMEOUT_MS);

  describe("E4: a Nest CLI monorepo", () => {
    const DEFAULT_PROJECT_NOTE =
      "nest-graph-inspector: nest-cli.json defines applications api, worker; using the default project api (pass --app <name> for another)\n";

    it("exports the default project, and says which it is", async () => {
      const result = await exportIn("monorepo");

      expectExported(result, "ApiModule", {
        present: ["SharedModule"],
        absent: ["WorkerModule"],
      });
      expect(result.stderr).toContain(DEFAULT_PROJECT_NOTE);
    }, SPAWN_TIMEOUT_MS);

    it("exports a monorepo whose nest-cli.json names no builder from tsc's output, as the Nest CLI builds it", async () => {
      const result = await exportIn("monorepo-no-builder");

      expectExported(result, "ApiModule", {
        present: ["SharedModule"],
        absent: ["WorkerModule"],
      });
      expect(result.stderr).toContain(
        "nest-graph-inspector: entry dist/apps/api/apps/api/src/api.module.js (ApiModule, from apps/api/src/main.ts)\n",
      );
    }, SPAWN_TIMEOUT_MS);

    it("says which application an app.module.js found by convention is, unless --app named it", async () => {
      const [detected, named] = await Promise.all([
        exportIn("monorepo-convention"),
        exportIn("monorepo-convention", ["--app", "api"]),
      ]);

      for (const result of [detected, named]) {
        expectExported(result, "AppModule", {
          present: ["SharedModule"],
          absent: ["WorkerModule"],
        });
        expect(result.stderr).not.toContain("nest-graph-inspector: entry ");
      }
      expect(detected.stderr).toContain(DEFAULT_PROJECT_NOTE);
      expect(named.stderr).not.toContain("defines applications");
    }, SPAWN_TIMEOUT_MS);

    it("never loads an app.module.js an older build left where --app's tsc no longer writes", async () => {
      const result = await exportIn("monorepo-own-layout", ["--app", "worker"]);

      expectExported(result, "WorkerModule", { present: [], absent: ["AppModule"] });
      expect(result.stderr).toContain(
        "nest-graph-inspector: entry dist/worker/worker/src/worker.module.js (WorkerModule, from apps/worker/src/main.ts)\n",
      );
    }, SPAWN_TIMEOUT_MS);

    it("never loads, for --app, a root module another application's build wrote to the same path", async () => {
      const [refused, loaded] = await Promise.all([
        exportIn("monorepo-same-root-path", ["--app", "worker"]),
        exportIn("monorepo-same-root-path", ["--app", "worker", "--require", "./ts-loader.cjs"]),
      ]);

      expectRefused(
        refused,
        1,
        "nest-graph-inspector: apps/worker/src/main.ts boots RootModule from apps/worker/src/root.module.ts, built to dist/root.module.js — but another application's apps/api/src/root.module.ts builds to dist/root.module.js too, so whose it is cannot be told. Pass --entry with the file to load, or load the TypeScript source: ",
      );
      // With a loader, worker's own TypeScript source: its feature, not api's.
      expectExported(loaded, "RootModule", {
        present: ["WorkerFeatureModule"],
        absent: ["ApiFeatureModule"],
      });
    }, SPAWN_TIMEOUT_MS);

    it("never loads, for --app, a root module another build wrote from a source at another path", async () => {
      const [refused, loaded] = await Promise.all([
        exportIn("monorepo-root-dirs", ["--app", "worker"]),
        exportIn("monorepo-root-dirs", ["--app", "worker", "--require", "./ts-loader.cjs"]),
      ]);

      expectRefused(
        refused,
        1,
        "nest-graph-inspector: apps/worker/src/main.ts boots RootModule from apps/worker/src/src/root.module.ts, built to dist/src/root.module.js — but another application's apps/api/src/root.module.ts builds to dist/src/root.module.js too, so whose it is cannot be told. Pass --entry with the file to load, or load the TypeScript source: ",
      );
      expectExported(loaded, "RootModule", {
        present: ["WorkerFeatureModule"],
        absent: ["ApiFeatureModule"],
      });
      expect(loaded.stderr).toContain(
        "nest-graph-inspector: entry apps/worker/src/src/root.module.ts (RootModule, from apps/worker/src/main.ts)\n",
      );
    }, SPAWN_TIMEOUT_MS);

    it("exports, for --app, its tsc build's own file, which a webpack application with a source at that path never writes", async () => {
      const result = await exportIn("monorepo-bundled-sibling", ["--app", "api"]);

      expectExported(result, "RootModule", {
        present: ["ApiFeatureModule"],
        absent: ["WorkerFeatureModule"],
      });
      expect(result.stderr).toContain(
        "nest-graph-inspector: entry dist/root.module.js (RootModule, from apps/api/src/main.ts)\n",
      );
    }, SPAWN_TIMEOUT_MS);

    it("takes neither of --app's two SWC layouts of app.module.js, before setting aside the one another application writes, and never loads the stale one", async () => {
      const result = await exportIn("monorepo-swc-two-layouts", ["--app", "worker"]);

      expectExported(result, "WorkerModule", { present: [], absent: ["AppModule"] });
      expect(result.stderr).toContain(
        "nest-graph-inspector: entry dist/worker.module.js (WorkerModule, from src/main.ts)\n",
      );
    }, SPAWN_TIMEOUT_MS);

    it("never takes another application's app.module.js from an outDir they share", async () => {
      const [worker, detected] = await Promise.all([
        exportIn("monorepo-shared-out-dir", ["--app", "worker"]),
        exportIn("monorepo-shared-out-dir"),
      ]);

      expectExported(worker, "WorkerModule", { present: [], absent: ["AppModule"] });
      expect(worker.stderr).toContain(
        "nest-graph-inspector: entry dist/apps/worker/src/worker.module.js (WorkerModule, from apps/worker/src/main.ts)\n",
      );
      // Without --app, the convention finds what it always has: the default
      // project's own.
      expectExported(detected, "AppModule", { present: [], absent: ["WorkerModule"] });
      expect(detected.stderr).toContain(DEFAULT_PROJECT_NOTE);
    }, SPAWN_TIMEOUT_MS);

    it("exports the application --app names", async () => {
      const result = await exportIn("monorepo", ["--app", "worker"]);

      expectExported(result, "WorkerModule", {
        present: ["SharedModule"],
        absent: ["ApiModule"],
      });
      expect(result.stderr).toContain(
        "nest-graph-inspector: entry dist/apps/worker/apps/worker/src/worker.module.js (WorkerModule, from apps/worker/src/main.ts)\n",
      );
    }, SPAWN_TIMEOUT_MS);

    it("rejects an --app nest-cli.json does not define, listing those it does", async () => {
      const [unknown, library] = await Promise.all([
        exportIn("monorepo", ["--app", "nope"]),
        exportIn("monorepo", ["--app", "shared"]),
      ]);

      expectRefused(
        unknown,
        2,
        'nest-graph-inspector: nest-cli.json has no project "nope". Pass --app with one of: api, worker.\n',
      );
      expectRefused(
        library,
        2,
        'nest-graph-inspector: "shared" is a library, which has no main.ts. Pass --app with one of: api, worker.\n',
      );
    }, SPAWN_TIMEOUT_MS);
  });

  describe.each(["webpack", "rspack"])("E5: a %s build", (bundler) => {
    const project = `bundled-${bundler}`;

    it("never loads its main.js, and names the command that loads the TypeScript source instead", async () => {
      const [detected, given] = await Promise.all([
        exportIn(project),
        exportIn(project, ["--entry", "dist/main.js"]),
      ]);

      expectRefused(
        detected,
        1,
        `nest-graph-inspector: The project is built with ${bundler} into one main.js, which starts the application when it is loaded. Its root module is BundledRootModule in src/bundled-root.module.ts. Run: nest-graph-inspector export --out `,
      );
      expect(detected.stderr).toMatch(
        / --out \S+graph\.json --require ts-node\/register\n$/,
      );
      expectRefused(
        given,
        1,
        "nest-graph-inspector: dist/main.js starts the application (it calls NestFactory.create), so the export will not load it",
      );
    }, SPAWN_TIMEOUT_MS);

    it("exports the TypeScript root module through a --require loader", async () => {
      const result = await exportIn(project, ["--require", "./ts-loader.cjs"]);

      expectExported(result, "BundledRootModule", { present: ["FeatureModule"] });
      expect(result.stderr).toContain(
        "nest-graph-inspector: entry src/bundled-root.module.ts (BundledRootModule, from src/main.ts)\n",
      );
    }, SPAWN_TIMEOUT_MS);
  });

  it("E6: exports an application not built yet through a --require loader, and names the command without one", async () => {
    const [unbuilt, loaded] = await Promise.all([
      exportIn("unbuilt"),
      exportIn("unbuilt", ["--require", "./ts-loader.cjs"]),
    ]);

    expectRefused(
      unbuilt,
      1,
      "nest-graph-inspector: No compiled UnbuiltRootModule found: src/main.ts boots it from src/unbuilt-root.module.ts, which has not been built to dist/unbuilt-root.module.js. Build your project first (nest build), or run: nest-graph-inspector export --out ",
    );
    expect(unbuilt.stderr).toMatch(/ --require ts-node\/register\n$/);
    expectExported(loaded, "UnbuiltRootModule", { present: ["ChildModule"] });
  }, SPAWN_TIMEOUT_MS);

  it("E6: says what a --require loader must do when the TypeScript source it was to load fails to", async () => {
    const result = await exportIn("unbuilt", ["--require", "./no-loader.cjs"]);

    expectRefused(result, 1, "nest-graph-inspector: Loading src/unbuilt-root.module.ts failed: ");
    expect(result.stderr).toContain(
      "\nsrc/unbuilt-root.module.ts is TypeScript, loaded through --require ./no-loader.cjs: the loader must register .ts files and emit the decorator metadata Nest reads (--require ts-node/register does both).\n",
    );
  }, SPAWN_TIMEOUT_MS);

  it("E7: refuses a one-file application, however it is pointed at, loading nothing", async () => {
    const [detected, compiled, source] = await Promise.all([
      exportIn("one-file"),
      exportIn("one-file", ["--entry", "dist/main.js"]),
      exportIn("one-file", ["--entry", "src/main.ts", "--require", "./ts-loader.cjs"]),
    ]);

    expectRefused(
      detected,
      1,
      "nest-graph-inspector: src/main.ts declares its root module AppModule itself, and loading src/main.ts would start the application, so the export will not load it.",
    );
    expectRefused(
      compiled,
      1,
      "nest-graph-inspector: dist/main.js starts the application (it calls NestFactory.create), so the export will not load it: loading it would run your bootstrap — listen on a port, connect to a database. Point --entry at the file that exports your root module (e.g. dist/app.module.js).\n",
    );
    expectRefused(
      source,
      1,
      "nest-graph-inspector: src/main.ts starts the application (it calls NestFactory.create)",
    );
  }, SPAWN_TIMEOUT_MS);

  describe("E8: what the export has always found", () => {
    it("exports dist/app.module.js exactly as before, saying nothing new", async () => {
      const [detected, given] = await Promise.all([
        exportIn("standard"),
        exportIn("standard", ["--entry", "dist/app.module.js"]),
      ]);

      expectExported(detected, "AppModule", { present: ["ChildModule"] });
      expectExported(given, "AppModule", { present: ["ChildModule"] });
      // The same file, loaded the same way, for the same graph.
      expect(detected.graph).toEqual(given.graph);
      expect(detected.stderr).toContain("app.module loaded\n");
      expect(detected.stderr).not.toContain("nest-graph-inspector: entry ");
      expect(detected.stderr).not.toContain("nest-graph-inspector: warning");
    }, SPAWN_TIMEOUT_MS);

    it("keeps to dist/app.module.js when main.ts boots another module, and warns", async () => {
      const result = await exportIn("convention-wins");

      expectExported(result, "AppModule", {
        present: ["ChildModule"],
        absent: ["OtherRootModule"],
      });
      expect(result.stderr).toContain("app.module loaded\n");
      expect(result.stderr).not.toContain("other-root.module loaded");
      expect(result.stderr).not.toContain("nest-graph-inspector: entry ");
      expect(result.stderr).toContain(
        "nest-graph-inspector: warning: src/main.ts boots OtherRootModule from src/other-root.module.ts, but the export uses dist/app.module.js (AppModule) by convention. Pass --entry dist/other-root.module.js --module OtherRootModule to export OtherRootModule.\n",
      );
    }, SPAWN_TIMEOUT_MS);
  });

  describe("E9: what the user names wins", () => {
    it("asks which root module, when main.ts boots two", async () => {
      expectRefused(
        await exportIn("two-roots"),
        1,
        "nest-graph-inspector: src/main.ts boots 2 root modules (WorkerModule, ApiModule). Pass --module <name>.\n",
      );
    }, SPAWN_TIMEOUT_MS);

    it("takes --entry and --module as given, without reading main.ts", async () => {
      const result = await exportIn("two-roots", [
        "--entry",
        "dist/worker.module.js",
        "--module",
        "WorkerModule",
      ]);

      expectExported(result, "WorkerModule", { present: [], absent: ["ApiModule"] });
      expect(result.stderr).not.toContain("src/main.ts");
    }, SPAWN_TIMEOUT_MS);

    it("takes the root module --module names among those main.ts boots", async () => {
      const result = await exportIn("two-roots", ["--module", "ApiModule"]);

      expectExported(result, "ApiModule", { present: [], absent: ["WorkerModule"] });
      expect(result.stderr).toContain(
        "nest-graph-inspector: entry dist/api.module.js (ApiModule, from src/main.ts)\n",
      );
    }, SPAWN_TIMEOUT_MS);
  });

  it("E12: boots the module a local name holds, not the import it shadows", async () => {
    const result = await exportIn("local-root");

    expectExported(result, "WorkerModule", { present: [], absent: ["ApiModule"] });
    expect(result.stderr).toContain(
      "nest-graph-inspector: entry dist/worker.module.js (WorkerModule, from src/main.ts)\n",
    );
  }, SPAWN_TIMEOUT_MS);

  it("E13: reads a barrel's export const as JavaScript does, so the convention's own module raises no warning", async () => {
    const result = await exportIn("barrel-const");

    expectExported(result, "AppModule", { present: [], absent: ["RootModule"] });
    expect(result.stderr).not.toContain("nest-graph-inspector: warning");
  }, SPAWN_TIMEOUT_MS);

  it("E14: takes neither of two SWC layouts, one of them stale, unless the source is loaded instead", async () => {
    const [refused, loaded] = await Promise.all([
      exportIn("swc-both-layouts"),
      exportIn("swc-both-layouts", ["--require", "./ts-loader.cjs"]),
    ]);

    expectRefused(
      refused,
      1,
      "nest-graph-inspector: apps/api/src/main.ts boots SwcRootModule from apps/api/src/swc-root.module.ts, which SWC has built to both dist/apps/api/src/swc-root.module.js and dist/api/src/swc-root.module.js: Nest CLI 12 and Nest CLI 11 lay out its output differently, so one of them is left from an older build. Pass --entry with the current one, build again into an emptied outDir, or run: ",
    );
    expectExported(loaded, "SwcRootModule", { present: [] });
    expect(loaded.stderr).toContain(
      "nest-graph-inspector: entry apps/api/src/swc-root.module.ts (SwcRootModule, from apps/api/src/main.ts)\n",
    );
  }, SPAWN_TIMEOUT_MS);

  it("E15: takes neither of two files tsc wrote from root directories it inferred differently, unless told which or given a loader", async () => {
    const [refused, given, loaded] = await Promise.all([
      exportIn("tsc-inferred-roots"),
      exportIn("tsc-inferred-roots", ["--entry", "dist/src/inferred-root.module.js"]),
      exportIn("tsc-inferred-roots", ["--require", "./ts-loader.cjs"]),
    ]);

    expectRefused(
      refused,
      1,
      "nest-graph-inspector: src/main.ts boots InferredRootModule from src/inferred-root.module.ts, which has been built to dist/src/inferred-root.module.js and dist/inferred-root.module.js: each is where a build from a different root directory writes it, so all but one of them are left from older builds. Pass --entry with the current one, build again into an emptied outDir, or run: ",
    );
    expectExported(given, "InferredRootModule", { present: [] });
    expectExported(loaded, "InferredRootModule", { present: [] });
    expect(loaded.stderr).toContain(
      "nest-graph-inspector: entry src/inferred-root.module.ts (InferredRootModule, from src/main.ts)\n",
    );
  }, SPAWN_TIMEOUT_MS);

  it("E16: says which boot it passed over, by line, when another boot's root module decides", async () => {
    const result = await exportIn("skipped-boot");

    expectExported(result, "RootModule", { present: [] });
    expect(result.stderr).toContain(
      "nest-graph-inspector: entry dist/root.module.js (RootModule, from src/main.ts)\n" +
        "nest-graph-inspector: skipped src/main.ts:8 NestFactory.createApplicationContext(rootFor(process.env.APP)): its root module is not an import the export can follow\n",
    );
  }, SPAWN_TIMEOUT_MS);

  it("E17: takes the root module --module names by the const main.ts boots it through", async () => {
    const result = await exportIn("alias-roots", ["--module", "Worker"]);

    expectExported(result, "WorkerModule", { present: [], absent: ["ApiModule"] });
    expect(result.stderr).toContain(
      "nest-graph-inspector: entry dist/worker.module.js (WorkerModule, from src/main.ts)\n",
    );
  }, SPAWN_TIMEOUT_MS);

  it("E18: resolves an .mts main.ts's import = require() as CommonJS does, without an extension", async () => {
    const result = await exportIn("mts-require");

    expectExported(result, "RootModule", { present: ["ChildModule"] });
    expect(result.stderr).toContain(
      "nest-graph-inspector: entry dist/root.module.js (RootModule, from src/main.mts)\n",
    );
  }, SPAWN_TIMEOUT_MS);

  it("E19: warns that main.ts boots another module, through a barrel whose default-exported function of that name hides nothing", async () => {
    const result = await exportIn("barrel-default-function");

    expectExported(result, "AppModule", { present: [], absent: ["RootModule"] });
    expect(result.stderr).toContain(
      "nest-graph-inspector: warning: src/main.ts boots RootModule from src/modules/root.module.ts, but the export uses dist/app.module.js (AppModule) by convention. Pass --entry dist/modules/root.module.js --module RootModule to export RootModule.\n",
    );
  }, SPAWN_TIMEOUT_MS);

  it("E10: counts only @nestjs/core's NestFactory, so another object's create(), or a shadowing parameter's, is no second root module", async () => {
    const result = await exportIn("own-factory");

    expectExported(result, "RootModule", { present: [], absent: ["HelperModule"] });
    expect(result.stderr).toContain(
      "nest-graph-inspector: entry dist/root.module.js (RootModule, from src/main.ts)\n",
    );
  }, SPAWN_TIMEOUT_MS);

  it("E11: exports an SWC build from the outDir its builder options name, never the tsconfig's", async () => {
    const result = await exportIn("swc-out-dir");

    expectExported(result, "SwcRootModule", { present: ["ChildModule"] });
    expect(result.stderr).toContain(
      "nest-graph-inspector: entry build/swc-root.module.js (SwcRootModule, from src/main.ts)\n",
    );
  }, SPAWN_TIMEOUT_MS);
});
