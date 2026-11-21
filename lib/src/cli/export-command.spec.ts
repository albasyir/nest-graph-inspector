import { join } from "node:path";
import { loadFailedMessage } from "./export-command";

describe(loadFailedMessage.name, () => {
  const cwd = join("/", "project");

  it("says why loading a compiled file failed, and nothing more", () => {
    expect(
      loadFailedMessage(
        join(cwd, "dist", "app.module.js"),
        new Error("FIXTURE_DATABASE_URL is not set"),
        ["dotenv/config"],
        cwd,
      ),
    ).toBe("Loading dist/app.module.js failed: FIXTURE_DATABASE_URL is not set");
  });

  it("says what a preload must do, for a TypeScript file loaded with --require preloads", () => {
    expect(
      loadFailedMessage(
        join(cwd, "src", "root.module.ts"),
        new SyntaxError("Invalid or unexpected token"),
        ["dotenv/config", "./loader.cjs"],
        cwd,
      ),
    ).toBe(
      "Loading src/root.module.ts failed: Invalid or unexpected token\n" +
        "src/root.module.ts is TypeScript, preloaded with --require dotenv/config --require ./loader.cjs: a preload must register .ts files and emit the decorator metadata Nest reads (--require ts-node/register does both when the tsconfig it reads sets emitDecoratorMetadata).",
    );
  });

  it("names the extension a preload must register", () => {
    expect(
      loadFailedMessage(join(cwd, "src", "root.module.cts"), new Error("boom"), ["./loader.cjs"], cwd),
    ).toContain("a preload must register .cts files");
  });
});
