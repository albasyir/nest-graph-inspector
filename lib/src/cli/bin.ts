#!/usr/bin/env node
import { processIo, runCli } from "./cli";

const io = processIo();

// Exits explicitly once output has been flushed: an application's module
// files can start timers or open handles when they are loaded, and those must
// not keep the CLI alive after the export is done.
runCli(process.argv.slice(2), io).then(exitWhenFlushed, (error: unknown) => {
  io.stderr.write(`nest-graph-inspector: ${String(error)}\n`);
  exitWhenFlushed(1);
});

function exitWhenFlushed(exitCode: number): void {
  io.stdout.write("", () => io.stderr.write("", () => process.exit(exitCode)));
}
