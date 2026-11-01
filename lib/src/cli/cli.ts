import { parseArgs } from "node:util";
import { CliError, describeError, stackOf } from "./cli-error";

const { version } = require("../../package.json") as { version: string };

export type CliIo = {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
  cwd: string;
};

const OPTIONS = {
  entry: { type: "string" },
  module: { type: "string" },
  out: { type: "string", short: "o" },
  project: { type: "string", short: "p" },
  require: { type: "string", short: "r", multiple: true },
  "env-file": { type: "string", multiple: true },
  compact: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

export const HELP = `Usage: nest-graph-inspector export [options]

Writes the dependency graph of a NestJS application without running it. The
application is booted in Nest's own preview mode, which builds the module
container but instantiates no provider or controller and calls no lifecycle
hook. The file is the GraphOutput JSON a running inspector serves at
/output.json.

Options:
  --entry <file>      File exporting the root module, compiled JavaScript or —
                      with a --require loader — TypeScript. Default: found from
                      nest-cli.json and the tsconfig outDir, such as
                      dist/app.module.js or dist/src/app.module.js
  --module <name>     Export name of the root module class (default: AppModule,
                      or the file's only exported module)
  -o, --out <file>    Where to write the graph; "-" for stdout
                      (default: nest-graph.json)
  -p, --project <dir> Project root; the application is booted from there, as
                      it is when started (default: the current directory)
  --env-file <file>   Load environment variables from a file before anything
                      else, for an application whose main.ts loads them
                      before importing AppModule; repeatable. Needs Node.js
                      20.12 or later; --require dotenv/config also works
  -r, --require <id>  Module to load first, resolved from the project, such as
                      ts-node/register or tsconfig-paths/register; repeatable
  --compact           Write the JSON on one line, as /output.json serves it
  -h, --help          Show this help
  -v, --version       Show the version

--entry, --out, --project and --env-file are relative to the current
directory.
`;

/**
 * The process's own output streams, with their `write` captured now — before
 * an application's module files get the chance to replace it — so the graph,
 * the CLI's messages, and the final flush never pass through code the
 * application installed.
 */
export function processIo(): CliIo {
  return {
    stdout: { write: process.stdout.write.bind(process.stdout) },
    stderr: { write: process.stderr.write.bind(process.stderr) },
    cwd: process.cwd(),
  };
}

/**
 * Runs the CLI with `argv` (without `node` and the script) and returns its
 * exit code. `export` diverts `process.stdout` to stderr for the rest of the
 * process, so it belongs in a process of its own, as `bin.ts` runs it.
 */
export async function runCli(
  argv: readonly string[],
  io: CliIo = processIo(),
): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    return usageError(io, describeError(error));
  }

  const { values, positionals } = parsed;
  if (values.version) {
    io.stdout.write(`${version}\n`);
    return 0;
  }

  if (values.help) {
    io.stdout.write(HELP);
    return 0;
  }

  const [command, ...extra] = positionals;
  if (command === undefined) {
    io.stderr.write(HELP);
    return 2;
  }

  if (command !== "export") {
    return usageError(io, `Unknown command "${command}".`);
  }

  if (extra.length) {
    return usageError(io, `Unexpected argument "${extra[0]}".`);
  }

  try {
    // Loaded on demand, so --help and --version never load TypeScript or Nest.
    const { runExportCommand } = await import("./export-command");
    return await runExportCommand(argv, values, io);
  } catch (error) {
    io.stderr.write(
      error instanceof CliError
        ? `nest-graph-inspector: ${error.message}\n${
            error.cause === undefined ? "" : `${stackOf(error.cause)}\n`
          }`
        : `nest-graph-inspector: export failed: ${stackOf(error)}\n`,
    );
    return 1;
  }
}

function parseCliArgs(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
}

function usageError(io: CliIo, message: string): number {
  io.stderr.write(
    `nest-graph-inspector: ${message}\nRun "nest-graph-inspector --help" for usage.\n`,
  );
  return 2;
}
