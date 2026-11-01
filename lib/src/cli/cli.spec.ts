import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELP, runCli } from "./cli";

const { version } = require("../../package.json") as { version: string };

describe(runCli.name, () => {
  let cwd: string;
  let stdout: string;
  let stderr: string;

  const run = (...argv: string[]) =>
    runCli(argv, {
      cwd,
      stdout: {
        write: (text: string | Uint8Array) => {
          stdout += String(text);
          return true;
        },
      },
      stderr: {
        write: (text: string | Uint8Array) => {
          stderr += String(text);
          return true;
        },
      },
    });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "nest-graph-inspector-cli-"));
    stdout = "";
    stderr = "";
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("prints its help", async () => {
    await expect(run("--help")).resolves.toBe(0);
    await expect(run("export", "-h")).resolves.toBe(0);

    expect(stdout).toBe(HELP + HELP);
    expect(HELP).toContain("Usage: nest-graph-inspector export [options]");
  });

  it("prints its version", async () => {
    await expect(run("--version")).resolves.toBe(0);

    expect(stdout).toBe(`${version}\n`);
  });

  it("prints the help to stderr and fails without a command", async () => {
    await expect(run()).resolves.toBe(2);

    expect(stdout).toBe("");
    expect(stderr).toBe(HELP);
  });

  it.each([
    [["graph"], 'Unknown command "graph".'],
    [["export", "extra"], 'Unexpected argument "extra".'],
    [["export", "--entrypoint", "x"], "Unknown option '--entrypoint'"],
    [["export", "--out"], "Option '-o, --out <value>' argument missing"],
  ])("rejects %j as a usage error", async (argv, message) => {
    await expect(run(...argv)).resolves.toBe(2);

    expect(stderr).toContain(`nest-graph-inspector: ${message}`);
    expect(stderr).toContain('Run "nest-graph-inspector --help" for usage.');
  });

  it("fails when the project directory does not exist", async () => {
    await expect(run("export", "--project", "missing")).resolves.toBe(1);

    expect(stderr).toBe(
      `nest-graph-inspector: Project directory not found: ${join(cwd, "missing")}\n`,
    );
  });

  it("asks for a build when it finds no compiled application", async () => {
    await expect(run("export")).resolves.toBe(1);

    expect(stderr).toBe(
      "nest-graph-inspector: No compiled application found: dist does not exist. Build your project first (nest build), or pass --entry <file>.\n",
    );
  });

  it("fails when --entry does not exist", async () => {
    await expect(run("export", "--entry", "dist/main.module.js")).resolves.toBe(
      1,
    );

    expect(stderr).toBe(
      "nest-graph-inspector: Entry file not found: dist/main.module.js. Check the --entry path, and build your project first (nest build) if it points at compiled output.\n",
    );
  });

  it("asks for a loader before loading a TypeScript entry", async () => {
    mkdirSync(join(cwd, "src"));
    writeFileSync(join(cwd, "src/app.module.ts"), "export class AppModule {}");

    await expect(run("export", "--entry", "src/app.module.ts")).resolves.toBe(
      1,
    );

    expect(stderr).toBe(
      "nest-graph-inspector: src/app.module.ts is TypeScript, which Node cannot load on its own. Build your project and pass the compiled file, or add a loader that emits decorator metadata: --require ts-node/register (and --require tsconfig-paths/register for path aliases).\n",
    );
  });
});
