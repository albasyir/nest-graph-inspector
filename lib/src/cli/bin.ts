#!/usr/bin/env node
import { processIo, runCli } from "./cli";

const io = processIo();
// Taken now, like the streams above, before any of the application's files
// load: one that replaces process.exit must not be able to keep the CLI alive.
const exit = process.exit.bind(process);

// Exits explicitly once output has been flushed: an application's module
// files can start timers or open handles when they are loaded, and those must
// not keep the CLI alive after the export is done.
runCli(process.argv.slice(2), io).then(exitWhenFlushed, (error: unknown) => {
  io.stderr.write(`nest-graph-inspector: ${String(error)}\n`);
  exitWhenFlushed(1);
});

function exitWhenFlushed(exitCode: number): void {
  io.stdout.write("", () => io.stderr.write("", () => exit(exitCode)));
}
