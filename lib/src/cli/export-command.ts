import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { GraphOutput } from "../types/graph-output.type";
import { CliError, describeError } from "./cli-error";
import type { CliIo } from "./cli";
import {
  detectEntry,
  displayPath,
  findProjectPackage,
  isDirectory,
  isFile,
  isTypeScriptFile,
  loadModule,
  loadNestCore,
  readOwnPackage,
  selectEntryModule,
} from "./project";
import { createStderrLogger } from "./stderr-logger";

export const DEFAULT_OUT_FILE = "nest-graph.json";

/** Set on a CLI started by another copy of itself, so it never delegates again. */
export const DELEGATED_ENV = "NEST_GRAPH_INSPECTOR_CLI_DELEGATED";

export type ExportCommandOptions = {
  entry?: string;
  module?: string;
  out?: string;
  project?: string;
  require?: string[];
  compact?: boolean;
};

/**
 * `nest-graph-inspector export`: writes the graph of the project's
 * application, booted in Nest's preview mode, as `GraphOutput` JSON — the
 * document a running inspector serves at `/output.json`.
 */
export async function runExportCommand(
  argv: readonly string[],
  options: ExportCommandOptions,
  io: CliIo,
): Promise<number> {
  const projectDir = resolve(io.cwd, options.project ?? ".");
  if (!isDirectory(projectDir)) {
    throw new CliError(`Project directory not found: ${projectDir}`);
  }

  const projectRequire = createRequire(join(projectDir, "package.json"));
  const delegatedExitCode = delegateToProjectPackage(argv, projectRequire, io);
  if (delegatedExitCode !== undefined) {
    return delegatedExitCode;
  }

  const entryPath = resolveEntry(options, projectDir, io.cwd);
  const out = options.out ?? DEFAULT_OUT_FILE;
  const outPath = out === "-" ? undefined : resolve(io.cwd, out);

  // Everything the application reads relative to its working directory —
  // .env files, tsconfig.json for JSDoc — is read from the project, exactly
  // as when it is started from there.
  process.chdir(projectDir);

  const { result, entryName } = await withStdoutOnStderr(async () => {
    for (const request of options.require ?? []) {
      try {
        projectRequire(request);
      } catch (error) {
        throw new CliError(
          `Cannot load --require ${request} from ${displayPath(projectDir, io.cwd)}: ${describeError(error)}`,
          { cause: error },
        );
      }
    }

    // Before the entry, so the application decorates its classes against the
    // same reflect-metadata and @nestjs/core this export boots it with.
    const { nestCore, boot } = loadNestCore(projectRequire, projectDir, io.cwd);
    let moduleExports: unknown;
    try {
      moduleExports = await loadModule(entryPath, projectRequire);
    } catch (error) {
      throw new CliError(
        `Loading ${displayPath(entryPath, io.cwd)} failed: ${describeError(error)}`,
        { cause: error },
      );
    }

    const entry = selectEntryModule(
      moduleExports,
      options.module,
      entryPath,
      io.cwd,
    );
    // Loaded only now, after the project's own reflect-metadata.
    const { exportGraph, PreviewBootstrapError } = await import(
      "./export-graph"
    );

    try {
      return {
        entryName: entry.name,
        result: await exportGraph({
          nestCore,
          entryModule: entry.module,
          boot,
          logger: createStderrLogger((text) => io.stderr.write(text)),
        }),
      };
    } catch (error) {
      if (error instanceof PreviewBootstrapError) {
        // Nest has already logged the cause, stack and all.
        throw new CliError(
          `${error.message}\n` +
            "Preview mode instantiates nothing, but it still loads your module files and evaluates their decorators: " +
            "an environment variable read at import time, or a forRoot()/register() that throws, fails the export as it would fail your application's start.",
        );
      }

      throw new CliError(
        `Building the graph of ${entry.name} failed: ${describeError(error)}`,
        { cause: error },
      );
    }
  });

  for (const warning of result.warnings) {
    io.stderr.write(`nest-graph-inspector: warning: ${warning}\n`);
  }

  const json = options.compact
    ? JSON.stringify(result.graph)
    : JSON.stringify(result.graph, null, 2);
  if (outPath) {
    try {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, json);
    } catch (error) {
      throw new CliError(
        `Cannot write ${displayPath(outPath, io.cwd)}: ${describeError(error)}`,
      );
    }
  } else {
    await new Promise<void>((done) => io.stdout.write(json, () => done()));
  }

  io.stderr.write(
    `nest-graph-inspector: exported ${describeGraph(result.graph, entryName)} to ${
      outPath ? displayPath(outPath, io.cwd) : "stdout"
    } (booted in Nest preview mode: nothing was instantiated)\n`,
  );

  return 0;
}

/**
 * The project's own copy of this package, when it is not this one and ships
 * this CLI, runs the export instead: the application imports
 * `NestGraphInspectorModule` from that copy, and the export tells its module
 * and options apart by class identity, which only that copy's classes match.
 */
function delegateToProjectPackage(
  argv: readonly string[],
  projectRequire: NodeJS.Require,
  io: CliIo,
): number | undefined {
  const projectPackage = findProjectPackage(projectRequire);
  const ownPackage = readOwnPackage();
  if (!projectPackage || projectPackage.root === ownPackage.root) {
    return undefined;
  }

  if (projectPackage.bin && isFile(projectPackage.bin) && !process.env[DELEGATED_ENV]) {
    io.stderr.write(
      `nest-graph-inspector: using the project's own nest-graph-inspector@${projectPackage.version} (${projectPackage.root})\n`,
    );
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, projectPackage.bin, ...argv],
      {
        cwd: io.cwd,
        stdio: "inherit",
        env: { ...process.env, [DELEGATED_ENV]: "1" },
      },
    );
    if (child.error) {
      throw new CliError(
        `Cannot run ${projectPackage.bin}: ${describeError(child.error)}`,
      );
    }

    return child.status ?? 1;
  }

  const cannotRun = projectPackage.bin
    ? `whose export CLI is missing (${projectPackage.bin})`
    : "which does not ship this export CLI";
  io.stderr.write(
    `nest-graph-inspector: warning: the project installs nest-graph-inspector@${projectPackage.version} (${projectPackage.root}), ${cannotRun}; exporting with nest-graph-inspector@${ownPackage.version} (${ownPackage.root}) instead. Upgrade the project's nest-graph-inspector for a graph built with its own options.\n`,
  );
  return undefined;
}

function resolveEntry(
  options: ExportCommandOptions,
  projectDir: string,
  cwd: string,
): string {
  const entryPath = options.entry
    ? resolve(cwd, options.entry)
    : detectEntry(projectDir, cwd);

  if (!isFile(entryPath)) {
    throw new CliError(
      `Entry file not found: ${displayPath(entryPath, cwd)}. Check the --entry path, and build your project first (nest build) if it points at compiled output.`,
    );
  }

  if (isTypeScriptFile(entryPath) && !options.require?.length) {
    throw new CliError(
      `${displayPath(entryPath, cwd)} is TypeScript, which Node cannot load on its own. ` +
        "Build your project and pass the compiled file, or add a loader that emits decorator metadata: " +
        "--require ts-node/register (and --require tsconfig-paths/register for path aliases).",
    );
  }

  return entryPath;
}

/**
 * While `run` executes, whatever the application writes to stdout — a
 * `console.log` in a module file, Nest's own logger — goes to stderr instead,
 * so standard output carries the graph and nothing else.
 */
async function withStdoutOnStderr<T>(run: () => Promise<T>): Promise<T> {
  const stdout = process.stdout as Partial<Pick<NodeJS.WriteStream, "write">>;
  const ownWrite = Object.getOwnPropertyDescriptor(stdout, "write");
  stdout.write = process.stderr.write.bind(process.stderr);

  try {
    return await run();
  } finally {
    if (ownWrite) {
      Object.defineProperty(stdout, "write", ownWrite);
    } else {
      delete stdout.write;
    }
  }
}

/** `AppModule (7 modules, 15 providers, 4 controllers, 3 cycles)`. */
function describeGraph(graph: GraphOutput, entryName: string): string {
  const modules = Object.values(graph.modules);
  const providers = modules.reduce(
    (total, module) => total + module.providers.length,
    0,
  );
  const controllers = modules.reduce(
    (total, module) => total + module.controllers.length,
    0,
  );
  const cycles =
    graph.cycles.modules.length +
    graph.cycles.providers.length +
    graph.cycles.controllers.length;
  const root =
    graph.root === entryName ? graph.root : `${graph.root} (entry ${entryName})`;

  return `${root} (${[
    plural(modules.length, "module"),
    plural(providers, "provider"),
    plural(controllers, "controller"),
    plural(cycles, "cycle"),
  ].join(", ")})`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
