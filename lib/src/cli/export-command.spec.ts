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

  it("says what the loader must do, for a TypeScript file loaded through --require", () => {
    expect(
      loadFailedMessage(
        join(cwd, "src", "root.module.ts"),
        new SyntaxError("Invalid or unexpected token"),
        ["dotenv/config", "./loader.cjs"],
        cwd,
      ),
    ).toBe(
      "Loading src/root.module.ts failed: Invalid or unexpected token\n" +
        "src/root.module.ts is TypeScript, loaded through --require dotenv/config --require ./loader.cjs: the loader must register .ts files and emit the decorator metadata Nest reads (--require ts-node/register does both).",
    );
  });

  it("names the extension the loader must register", () => {
    expect(
      loadFailedMessage(join(cwd, "src", "root.module.cts"), new Error("boom"), ["./loader.cjs"], cwd),
    ).toContain("the loader must register .cts files");
  });
});
