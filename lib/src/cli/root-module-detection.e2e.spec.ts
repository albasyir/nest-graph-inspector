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

    // E6: not built at all.
    writeProject("unbuilt", {
      "tsconfig.json": TSCONFIG({ rootDir: "src", outDir: "dist" }),
      "ts-loader.cjs": TS_LOADER,
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

    // E10: main.ts also calls create() on a NestFactory of its own, which
    // boots nothing.
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

async function bootstrap(): Promise<void> {
  markRan("bootstrap");
  tools.NestFactory.create(HelperModule);
  const app = await NestFactory.create(RootModule);
  await app.listen(3000);
}

void bootstrap();
`,
    };
    writeProject("own-factory", ownFactory, srcBuild(ownFactory));
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

  it("E10: counts only @nestjs/core's NestFactory, so another object's create() is no second root module", async () => {
    const result = await exportIn("own-factory");

    expectExported(result, "RootModule", { present: [], absent: ["HelperModule"] });
    expect(result.stderr).toContain(
      "nest-graph-inspector: entry dist/root.module.js (RootModule, from src/main.ts)\n",
    );
  }, SPAWN_TIMEOUT_MS);
});
