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
  greet(@Param("name") name: string): string {
    return this.greetings.greet(name);
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

type Run = { status: number | null; stdout: string; stderr: string };

let workDir: string;
let projectDir: string;
let bin: string;

function run(binPath: string, args: string[], cwd = projectDir): Promise<Run> {
  const env = { ...process.env };
  delete env.NEST_GRAPH_INSPECTOR_CLI_DELEGATED;

  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [binPath, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", fail);
    child.on("close", (status) => done({ status, stdout, stderr }));
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
    // An ES module entry, which require() cannot load on every Node version.
    writeFileSync(
      join(projectDir, "dist/app.module.mjs"),
      'export { AppModule } from "./app.module.js";\n',
    );
  }, 120_000);

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

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
  });

  it("writes only the graph to stdout with --out -", async () => {
    const result = await run(bin, ["export", "--out", "-", "--compact"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      JSON.stringify(readGraph(join(projectDir, "nest-graph.json"))),
    );
    expect(result.stderr).toContain("app.module loaded\n");
    expect(result.stderr).toContain(" to stdout (");
  });

  it("loads an ES module entry with import()", async () => {
    const out = join(workDir, "esm.json");
    const result = await run(bin, [
      "export",
      "--entry",
      "dist/app.module.mjs",
      "--out",
      out,
    ]);

    expect(result.status).toBe(0);
    expect(readGraph(out)).toEqual(
      readGraph(join(projectDir, "nest-graph.json")),
    );
  });

  it("hands the export to the project's own copy of the package", async () => {
    // Another copy of the same package, as npx or a global install would have.
    const otherNodeModules = join(workDir, "elsewhere/node_modules");
    linkDependencies(otherNodeModules);
    cpSync(
      join(projectDir, "node_modules/nest-graph-inspector"),
      join(otherNodeModules, "nest-graph-inspector"),
      { recursive: true },
    );
    const out = join(workDir, "delegated.json");

    const result = await run(
      join(otherNodeModules, "nest-graph-inspector/dist/cli/bin.js"),
      ["export", "--project", projectDir, "--out", out],
      workDir,
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      `nest-graph-inspector: using the project's own nest-graph-inspector@`,
    );
    expect(readGraph(out)).toEqual(
      readGraph(join(projectDir, "nest-graph.json")),
    );
  });

  it("falls back to the defaults when the project's copy cannot run the export", async () => {
    // The same application, installed with a version of the package that
    // shipped no CLI.
    const olderProjectDir = join(workDir, "older-project");
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
  });

  it("fails when the entry file does not exist", async () => {
    const result = await run(bin, ["export", "--entry", "dist/missing.js"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      "nest-graph-inspector: Entry file not found: dist/missing.js. Check the --entry path, and build your project first (nest build) if it points at compiled output.\n",
    );
  });

  it("prints its help", async () => {
    const result = await run(bin, ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Usage: nest-graph-inspector export \[options\]/);
  });
});
