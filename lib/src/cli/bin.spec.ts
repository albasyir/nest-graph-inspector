import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import type { GraphOutput } from "../types/graph-output.type";

/**
 * The CLI as a user runs it: the package compiled from these sources and
 * installed in a project's node_modules, run with `node` against that
 * project's own `nest build`-style output. Compiling here, rather than
 * reading lib/dist, keeps the spec from ever testing a stale build.
 */

const LIB_DIR = resolve(__dirname, "..", "..");

/** The fixture application, as a user would write it. */
const APPLICATION_SOURCES: Record<string, string> = {
  "src/marker.ts": `
import { appendFileSync } from "node:fs";
import { join } from "node:path";

/** Leaves a trace of the application's own code running, across processes. */
export function markRan(what: string): void {
  appendFileSync(join(__dirname, "..", "ran.log"), what + "\\n");
}
`,
  "src/greeting.service.ts": `
import { Injectable, OnModuleInit } from "@nestjs/common";
import { markRan } from "./marker";

/**
 * Greets people.
 */
@Injectable()
export class GreetingService implements OnModuleInit {
  constructor() {
    markRan("GreetingService.constructor");
  }

  onModuleInit(): void {
    markRan("GreetingService.onModuleInit");
  }

  greet(name: string): string {
    return "Hello, " + name;
  }
}
`,
  "src/greeting.controller.ts": `
import { Controller, Get, Param } from "@nestjs/common";
import { GreetingService } from "./greeting.service";
import { markRan } from "./marker";

/**
 * Serves greetings.
 */
@Controller("greetings")
export class GreetingController {
  constructor(private readonly greetings: GreetingService) {
    markRan("GreetingController.constructor");
  }

  @Get(":name")
  greet(@Param("name") name: string): { greeting: string } {
    return { greeting: this.greetings.greet(name) };
  }
}
`,
  "src/app.module.ts": `
import { Module } from "@nestjs/common";
import { NestGraphInspectorModule } from "nest-graph-inspector";
import { GreetingController } from "./greeting.controller";
import { GreetingService } from "./greeting.service";
import { markRan } from "./marker";

console.log("app.module loaded");

/**
 * The application.
 */
@Module({
  imports: [
    NestGraphInspectorModule.forRoot({
      ignore: {
        modules: ["InternalCoreModule"],
        providers: ["ModuleRef", "ApplicationConfig"],
      },
    }),
  ],
  controllers: [GreetingController],
  providers: [
    GreetingService,
    {
      provide: "DATABASE",
      useFactory: () => {
        markRan("DATABASE.useFactory");
        return {};
      },
    },
  ],
})
export class AppModule {
  constructor() {
    markRan("AppModule.constructor");
  }
}
`,
  "src/noisy.module.ts": `
import { Module } from "@nestjs/common";

// Writes after it has loaded, holds a handle open, and replaces
// process.stderr.write with one that never calls back.
setTimeout(() => console.log("late output from a timer"), 0);
setImmediate(() => console.log("late output from setImmediate"));
setInterval(() => undefined, 60_000);
process.stderr.write = () => true;

// Enough providers for a graph larger than a pipe's 64 KiB buffer.
@Module({
  providers: Array.from({ length: 3_000 }, (_, index) => ({
    provide: "NOISY_TOKEN_" + index,
    useValue: index,
  })),
})
export class NoisyModule {}
`,
  "src/env.module.ts": `
import { Module } from "@nestjs/common";

// Read when the file loads, as a config file that validates its environment
// does: main.ts would have loaded the environment before importing this.
const databaseUrl = process.env.FIXTURE_DATABASE_URL;
if (!databaseUrl) {
  throw new Error("FIXTURE_DATABASE_URL is not set");
}

@Module({
  providers: [{ provide: "DATABASE_URL=" + databaseUrl, useValue: databaseUrl }],
})
export class EnvModule {}
`,
  "src/broken.module.ts": `
import { Inject, Injectable, Module } from "@nestjs/common";

@Injectable()
class NeedsMissingProvider {
  constructor(@Inject("MISSING_TOKEN") readonly missing: unknown) {}
}

@Module({ providers: [NeedsMissingProvider] })
export class BrokenModule {}
`,
  "src/main.ts": `
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { markRan } from "./marker";

async function bootstrap(): Promise<void> {
  markRan("bootstrap");
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}

void bootstrap();
`,
};

const APPLICATION_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  strict: true,
  skipLibCheck: true,
  types: ["node"],
};

type Run = { status: number | string | null; stdout: string; stderr: string };

/** Generous: a busy CI runner may boot two Node processes for one export. */
const SPAWN_TIMEOUT_MS = 60_000;

let workDir: string;
let projectDir: string;
let bin: string;
/** Another installed copy of the package, as npx or a global install has. */
let otherBin: string;
/** A copy with ts-morph beside it but none of its Nest peers. */
let bareBin: string;
/** The application, installed with a version of the package without the CLI. */
let olderProjectDir: string;

function run(
  binPath: string,
  args: string[],
  cwd = projectDir,
  extraEnv: Record<string, string> = {},
): Promise<Run> {
  const env = { ...process.env, ...extraEnv };
  delete env.NEST_GRAPH_INSPECTOR_CLI_DELEGATED;
  // pnpm's bin shims export a NODE_PATH into its whole store, which would let
  // the CLI find packages a user's installation would not have beside it.
  delete env.NODE_PATH;

  return new Promise((done, fail) => {
    // A CLI that does not exit by itself is a failure, not a hung suite.
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd,
      env,
      timeout: SPAWN_TIMEOUT_MS - 5_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", fail);
    child.on("close", (status, signal) =>
      done({ status: signal ? `killed by ${signal}` : status, stdout, stderr }),
    );
  });
}

function compile(fileNames: string[], options: ts.CompilerOptions): void {
  const program = ts.createProgram(fileNames, options);
  const { diagnostics } = program.emit();
  const problems = [...ts.getPreEmitDiagnostics(program), ...diagnostics];
  if (problems.length) {
    throw new Error(
      ts.formatDiagnostics(problems, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => LIB_DIR,
        getNewLine: () => "\n",
      }),
    );
  }
}

/** Installs the package's runtime dependencies into `nodeModules` as links. */
function linkDependencies(nodeModules: string): void {
  const nestCommon = realpathSync(join(LIB_DIR, "node_modules/@nestjs/common"));
  const dependencies: Record<string, string> = {
    "@nestjs/common": nestCommon,
    "@nestjs/core": realpathSync(join(LIB_DIR, "node_modules/@nestjs/core")),
    // Its main file sits at the package root; its exports hide package.json.
    "reflect-metadata": dirname(
      require.resolve("reflect-metadata", { paths: [nestCommon] }),
    ),
    "ts-morph": realpathSync(join(LIB_DIR, "node_modules/ts-morph")),
    "@types/node": realpathSync(join(LIB_DIR, "node_modules/@types/node")),
  };

  for (const [name, target] of Object.entries(dependencies)) {
    mkdirSync(dirname(join(nodeModules, name)), { recursive: true });
    symlinkSync(target, join(nodeModules, name), "junction");
  }
}

/** The package as npm would install it: package.json plus a fresh build. */
function installPackage(nodeModules: string): string {
  const packageDir = join(nodeModules, "nest-graph-inspector");
  const config = ts.getParsedCommandLineOfConfigFile(
    join(LIB_DIR, "tsconfig.lib.json"),
    { outDir: join(packageDir, "dist"), declarationMap: false, sourceMap: false },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
      },
    },
  );
  if (!config) {
    throw new Error("Cannot read tsconfig.lib.json");
  }

  compile(config.fileNames, config.options);
  cpSync(join(LIB_DIR, "package.json"), join(packageDir, "package.json"));

  return packageDir;
}

function readGraph(path: string): GraphOutput {
  return JSON.parse(readFileSync(path, "utf8")) as GraphOutput;
}

describe("nest-graph-inspector bin", () => {
  beforeAll(() => {
    workDir = realpathSync(
      mkdtempSync(join(tmpdir(), "nest-graph-inspector-bin-")),
    );
    projectDir = join(workDir, "project");
    const nodeModules = join(projectDir, "node_modules");

    linkDependencies(nodeModules);
    const packageDir = installPackage(nodeModules);
    bin = join(packageDir, "dist/cli/bin.js");

    for (const [file, source] of Object.entries(APPLICATION_SOURCES)) {
      mkdirSync(dirname(join(projectDir, file)), { recursive: true });
      writeFileSync(join(projectDir, file), source);
    }
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "cli-fixture-app", private: true }),
    );
    writeFileSync(
      join(projectDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "commonjs",
          moduleResolution: "node",
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          strict: true,
          skipLibCheck: true,
          types: ["node"],
          rootDir: "src",
          outDir: "dist",
        },
        include: ["src"],
      }),
    );
    compile(
      Object.keys(APPLICATION_SOURCES).map((file) => join(projectDir, file)),
      {
        ...APPLICATION_COMPILER_OPTIONS,
        rootDir: join(projectDir, "src"),
        outDir: join(projectDir, "dist"),
      },
    );
    // Environment for EnvModule: two files, and a module that sets it when
    // required, as dotenv/config does.
    writeFileSync(join(projectDir, "first.env"), "FIXTURE_DATABASE_URL=first\n");
    writeFileSync(join(projectDir, "second.env"), "FIXTURE_DATABASE_URL=second\n");
    writeFileSync(
      join(projectDir, "load-env.js"),
      'process.env.FIXTURE_DATABASE_URL = "from-require";\n',
    );

    // ES module entries, which require() cannot load on every Node version.
    writeFileSync(
      join(projectDir, "dist/app.module.mjs"),
      'export { AppModule } from "./app.module.js";\n',
    );
    mkdirSync(join(projectDir, "dist-esm"));
    writeFileSync(
      join(projectDir, "dist-esm/package.json"),
      JSON.stringify({ type: "module" }),
    );
    writeFileSync(
      join(projectDir, "dist-esm/app.module.js"),
      'export { AppModule } from "../dist/app.module.js";\n',
    );

    const otherNodeModules = join(workDir, "elsewhere/node_modules");
    linkDependencies(otherNodeModules);
    cpSync(packageDir, join(otherNodeModules, "nest-graph-inspector"), {
      recursive: true,
    });
    otherBin = join(otherNodeModules, "nest-graph-inspector/dist/cli/bin.js");

    const bareNodeModules = join(workDir, "bare/node_modules");
    cpSync(packageDir, join(bareNodeModules, "nest-graph-inspector"), {
      recursive: true,
    });
    symlinkSync(
      realpathSync(join(LIB_DIR, "node_modules/ts-morph")),
      join(bareNodeModules, "ts-morph"),
      "junction",
    );
    bareBin = join(bareNodeModules, "nest-graph-inspector/dist/cli/bin.js");

    olderProjectDir = join(workDir, "older-project");
    cpSync(projectDir, olderProjectDir, {
      recursive: true,
      verbatimSymlinks: true,
    });
    const olderPackageJson = join(
      olderProjectDir,
      "node_modules/nest-graph-inspector/package.json",
    );
    const { bin: _bin, ...withoutBin } = JSON.parse(
      readFileSync(olderPackageJson, "utf8"),
    ) as Record<string, unknown>;
    writeFileSync(
      olderPackageJson,
      JSON.stringify({ ...withoutBin, version: "0.3.0" }),
    );
  }, 120_000);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  /**
   * The graph a plain `export` of the application writes, for the tests that
   * check another way of exporting against it. Exported the first time one of
   * them asks, and only once, so each also runs on its own.
   */
  let baseline: Promise<GraphOutput> | undefined;
  function baselineGraph(): Promise<GraphOutput> {
    const out = join(workDir, "baseline.json");

    baseline ??= run(bin, ["export", "--out", out]).then((result) => {
      if (result.status !== 0) {
        throw new Error(`The baseline export failed:\n${result.stderr}`);
      }

      return readGraph(out);
    });

    return baseline;
  }

  it("exports the application's graph without running any of it", async () => {
    const result = await run(bin, ["export"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    // Nothing the application's modules do on construction, in a factory,
    // or in a hook happened, and main.ts was never loaded.
    expect(existsSync(join(projectDir, "ran.log"))).toBe(false);
    // What a module file prints when it loads goes to stderr.
    expect(result.stderr).toContain("app.module loaded\n");
    expect(result.stderr).toContain(
      "nest-graph-inspector: exported AppModule (1 module, 2 providers, 1 controller, 0 cycles) to nest-graph.json (booted in Nest preview mode: nothing was instantiated)\n",
    );

    const graph = readGraph(join(projectDir, "nest-graph.json"));
    expect(graph.version).toBe("3");
    expect(graph.root).toBe("AppModule");
    // The application's forRoot() ignore was applied.
    expect(graph.modules.AppModule.imports).toEqual([]);
    expect(graph.modules.AppModule.jsdoc).toBe("The application.");
    expect(graph.modules.AppModule.providers).toEqual([
      expect.objectContaining({
        name: "GreetingService",
        jsdoc: "Greets people.",
        directRun: {
          methods: [{ name: "greet", parameterTypes: "[name: string]" }],
        },
      }),
      expect.objectContaining({ name: "useFactory" }),
    ]);
    expect(graph.modules.AppModule.controllers).toEqual([
      expect.objectContaining({
        name: "GreetingController",
        directRun: {
          methods: [
            {
              name: "greet",
              parameterTypes: "[name: string]",
              http: { method: "GET", path: "/greetings/:name" },
            },
          ],
        },
      }),
    ]);
    // The pretty file holds the same document the compact form does.
    expect(readFileSync(join(projectDir, "nest-graph.json"), "utf8")).toBe(
      JSON.stringify(graph, null, 2),
    );
  }, SPAWN_TIMEOUT_MS);

  it("writes only the graph to stdout with --out -", async () => {
    const [result, expected] = await Promise.all([
      run(bin, ["export", "--out", "-", "--compact"]),
      baselineGraph(),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(JSON.stringify(expected));
    expect(result.stderr).toContain("app.module loaded\n");
    expect(result.stderr).toContain(" to stdout (");
  }, SPAWN_TIMEOUT_MS);

  it.each(["dist/app.module.mjs", "dist-esm/app.module.js"])(
    "loads the ES module entry %s with import()",
    async (entry) => {
      const out = join(workDir, "esm.json");
      const [result, expected] = await Promise.all([
        run(bin, ["export", "--entry", entry, "--out", out]),
        baselineGraph(),
      ]);

      expect(result.status).toBe(0);
      expect(readGraph(out)).toEqual(expected);
    },
    SPAWN_TIMEOUT_MS,
  );

  it("keeps late application output off stdout, and exits though the application holds a handle open", async () => {
    const result = await run(bin, [
      "export",
      "--entry",
      "dist/noisy.module.js",
      "--out",
      "-",
      "--compact",
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("late output");
    const graph = JSON.parse(result.stdout) as GraphOutput;
    expect(result.stdout.length).toBeGreaterThan(64 * 1024);
    expect(graph.modules.NoisyModule.providers.length).toBeGreaterThan(3_000);
    // Printed through the stream's own write, which the application's
    // replacement of process.stderr.write does not reach.
    expect(result.stderr).toContain(
      "nest-graph-inspector: exported NoisyModule (",
    );
  }, SPAWN_TIMEOUT_MS);

  it.each([
    ["another copy", () => otherBin],
    ["a copy without its Nest peers beside it", () => bareBin],
  ])(
    "hands the export from %s to the project's own copy",
    async (_copy, copyBin) => {
      const out = join(workDir, "delegated.json");

      const [result, expected] = await Promise.all([
        run(
          copyBin(),
          ["export", "--project", projectDir, "--out", out],
          workDir,
        ),
        baselineGraph(),
      ]);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        `nest-graph-inspector: using the project's own nest-graph-inspector@`,
      );
      expect(readGraph(out)).toEqual(expected);
    },
    SPAWN_TIMEOUT_MS,
  );

  it("falls back to the defaults when the project's copy cannot run the export", async () => {
    const out = join(workDir, "older.json");

    const result = await run(
      bin,
      ["export", "--project", olderProjectDir, "--out", out],
      workDir,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "which does not ship this export CLI; exporting with nest-graph-inspector@",
    );
    expect(result.stderr).toContain(
      "imports NestGraphInspectorModule from a different copy of nest-graph-inspector",
    );
    const graph = readGraph(out);
    // The other copy's module is still left out, but its options went unread.
    expect(graph.modules).not.toHaveProperty("NestGraphInspectorModule");
    expect(graph.modules.AppModule.imports).toEqual(["InternalCoreModule"]);
    expect(existsSync(join(olderProjectDir, "ran.log"))).toBe(false);
  }, SPAWN_TIMEOUT_MS);

  it("explains, rather than crashes, when it can neither hand over nor load its own Nest peers", async () => {
    const result = await run(
      bareBin,
      ["export", "--project", olderProjectDir, "--out", join(workDir, "bare.json")],
      workDir,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "nest-graph-inspector: Cannot load nest-graph-inspector's own modules from ",
    );
    expect(result.stderr).toContain("Cannot find module '@nestjs/");
    expect(result.stderr).toContain(
      "Install nest-graph-inspector in the project and run the export there.",
    );
  }, SPAWN_TIMEOUT_MS);

  describe("an application whose main.ts loads its environment first", () => {
    const exportEnvModule = async (
      args: string[],
      env: Record<string, string> = {},
    ) => {
      const out = join(workDir, "env.json");
      const result = await run(
        bin,
        ["export", "--entry", "dist/env.module.js", "--out", out, ...args],
        projectDir,
        env,
      );
      const databaseUrl =
        result.status === 0
          ? readGraph(out)
              .modules.EnvModule.providers.map((provider) => provider.name)
              .find((name) => name.startsWith("DATABASE_URL="))
          : undefined;

      return { ...result, databaseUrl };
    };

    it("cannot load without that environment", async () => {
      const result = await exportEnvModule([]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "nest-graph-inspector: Loading dist/env.module.js failed: FIXTURE_DATABASE_URL is not set",
      );
    }, SPAWN_TIMEOUT_MS);

    it("loads with --env-file, where a later file and the environment win, as with node --env-file", async () => {
      expect(
        await exportEnvModule(["--env-file", "first.env"]),
      ).toMatchObject({ status: 0, databaseUrl: "DATABASE_URL=first" });
      expect(
        await exportEnvModule([
          "--env-file",
          "first.env",
          "--env-file",
          "second.env",
        ]),
      ).toMatchObject({ status: 0, databaseUrl: "DATABASE_URL=second" });
      expect(
        await exportEnvModule(["--env-file", "first.env"], {
          FIXTURE_DATABASE_URL: "from-environment",
        }),
      ).toMatchObject({ status: 0, databaseUrl: "DATABASE_URL=from-environment" });
    }, SPAWN_TIMEOUT_MS);

    it("loads with a --require module that sets it, as --require dotenv/config does", async () => {
      expect(
        await exportEnvModule(["--require", "./load-env.js"]),
      ).toMatchObject({ status: 0, databaseUrl: "DATABASE_URL=from-require" });
    }, SPAWN_TIMEOUT_MS);
  });

  it("fails with Nest's reason when the application cannot bootstrap", async () => {
    const result = await run(bin, [
      "export",
      "--entry",
      "dist/broken.module.js",
      "--module",
      "BrokenModule",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "nest-graph-inspector: Nest could not bootstrap BrokenModule in preview mode:",
    );
    expect(result.stderr).toContain("MISSING_TOKEN");
  }, SPAWN_TIMEOUT_MS);

  it("fails when the entry file does not exist", async () => {
    const result = await run(bin, ["export", "--entry", "dist/missing.js"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "nest-graph-inspector: Entry file not found: dist/missing.js. Check the --entry path, and build your project first (nest build) if it points at compiled output.\n",
    );
  }, SPAWN_TIMEOUT_MS);

  it("prints its help", async () => {
    const result = await run(bin, ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Usage: nest-graph-inspector export \[options\]/);
  }, SPAWN_TIMEOUT_MS);
});
