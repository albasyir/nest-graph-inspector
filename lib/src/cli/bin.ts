#!/usr/bin/env node
import { runCli } from "./cli";

// Exits explicitly once output has been flushed: an application's module
// files can start timers or open handles when they are loaded, and those must
// not keep the CLI alive after the export is done.
runCli(process.argv.slice(2)).then(exitWhenFlushed, (error: unknown) => {
  process.stderr.write(`nest-graph-inspector: ${String(error)}\n`);
  exitWhenFlushed(1);
});

function exitWhenFlushed(exitCode: number): void {
  process.stdout.write("", () =>
    process.stderr.write("", () => process.exit(exitCode)),
  );
}
