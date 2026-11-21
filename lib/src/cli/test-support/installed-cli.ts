import { spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import type { GraphOutput } from "../../types/graph-output.type";

/**
 * The CLI as a user runs it: the package compiled from these sources and
 * installed in a project's node_modules, run with `node`. Compiling here,
 * rather than reading lib/dist, keeps a spec from ever testing a stale build.
 * Shared by the specs that run the bin; tsconfig.lib.json leaves it out of
 * the package.
 */

export const LIB_DIR = resolve(__dirname, "..", "..", "..");

/** Generous: a busy CI runner may boot two Node processes for one export. */
export const SPAWN_TIMEOUT_MS = 60_000;

export type Run = { status: number | string | null; stdout: string; stderr: string };

/** How the fixture applications are compiled, as `nest build` would. */
export const APPLICATION_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  strict: true,
  skipLibCheck: true,
  types: ["node"],
};

/**
 * Runs a bin with `node` in `cwd`, with the environment a user's shell would
 * give it: no delegation marker, and no NODE_PATH.
 */
export function runBin(
  binPath: string,
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<Run> {
  const env = { ...process.env, ...options.env };
  delete env.NEST_GRAPH_INSPECTOR_CLI_DELEGATED;
  // pnpm's bin shims export a NODE_PATH into its whole store, which would let
  // the CLI find packages a user's installation would not have beside it.
  delete env.NODE_PATH;

  return new Promise((done, fail) => {
    // A CLI that does not exit by itself is a failure, not a hung suite.
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: options.cwd,
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

export function compile(fileNames: string[], options: ts.CompilerOptions): void {
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

/**
 * Installs the package's runtime dependencies into `nodeModules` as links —
 * and `extra` packages from lib's own node_modules, for a fixture that needs
 * one.
 */
export function linkDependencies(
  nodeModules: string,
  extra: readonly string[] = [],
): void {
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
    ...Object.fromEntries(
      extra.map((name) => [name, realpathSync(join(LIB_DIR, "node_modules", name))]),
    ),
  };

  for (const [name, target] of Object.entries(dependencies)) {
    mkdirSync(dirname(join(nodeModules, name)), { recursive: true });
    symlinkSync(target, join(nodeModules, name), "junction");
  }
}

/** The package as npm would install it: package.json plus a fresh build. */
export function installPackage(nodeModules: string): string {
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

export function readGraph(path: string): GraphOutput {
  return JSON.parse(readFileSync(path, "utf8")) as GraphOutput;
}
