import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Injectable, Module } from "@nestjs/common";
import { CliError } from "./cli-error";
import {
  detectEntry,
  findProjectPackage,
  loadModule,
  readOwnPackage,
  selectEntryModule,
} from "./project";

describe("project", () => {
  let projectDir: string;

  const write = (path: string, content = "") => {
    const file = join(projectDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "nest-graph-inspector-project-"));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe(detectEntry.name, () => {
    it("finds dist/app.module.js", () => {
      const entry = write("dist/app.module.js");

      expect(detectEntry(projectDir, projectDir)).toBe(entry);
    });

    it("finds the source root under the output directory, as nest build lays it out when the project is the TypeScript root", () => {
      write("nest-cli.json", JSON.stringify({ sourceRoot: "app" }));
      const entry = write("dist/app/app.module.js");
      write("dist/scripts/seed.js");

      expect(detectEntry(projectDir, projectDir)).toBe(entry);
    });

    it("reads outDir from the tsconfig nest build uses, following extends", () => {
      write(
        "tsconfig.json",
        `{
          // Comments and trailing commas are fine, as they are for tsc.
          "compilerOptions": { "outDir": "./build", },
        }`,
      );
      write("tsconfig.build.json", JSON.stringify({ extends: "./tsconfig.json" }));
      write("dist/app.module.js");
      const entry = write("build/src/app.module.js");

      expect(detectEntry(projectDir, projectDir)).toBe(entry);
    });

    it("reads the tsconfig nest-cli.json names", () => {
      write(
        "nest-cli.json",
        JSON.stringify({ compilerOptions: { tsConfigPath: "tsconfig.app.json" } }),
      );
      write("tsconfig.app.json", JSON.stringify({ compilerOptions: { outDir: "out" } }));
      const entry = write("out/app.module.js");

      expect(detectEntry(projectDir, projectDir)).toBe(entry);
    });

    it("finds the only app.module.js anywhere under the output directory", () => {
      const entry = write("dist/apps/api/src/app.module.js");
      write("dist/node_modules/some-package/app.module.js");

      expect(detectEntry(projectDir, projectDir)).toBe(entry);
    });

    it("asks for --entry when the output directory holds several", () => {
      write("dist/apps/api/app.module.js");
      write("dist/apps/worker/app.module.js");

      expect(() => detectEntry(projectDir, projectDir)).toThrow(
        "Found 2 app.module.js files under dist (dist/apps/api/app.module.js, dist/apps/worker/app.module.js). Pass --entry <file> to choose one.",
      );
    });

    it("asks for a build when there is no output directory", () => {
      expect(() => detectEntry(projectDir, projectDir)).toThrow(
        new CliError(
          "No compiled application found: dist does not exist. Build your project first (nest build), or pass --entry <file>.",
        ),
      );
    });

    it("asks for a build when the output directory has no app.module.js", () => {
      write("dist/main.js");

      expect(() => detectEntry(projectDir, resolve(projectDir, ".."))).toThrow(
        /^No app\.module\.js found under .*dist \(looked for .*app\.module\.js and .*src\/app\.module\.js\)\. Build your project first \(nest build\), or pass --entry <file>\.$/,
      );
    });
  });

  describe(selectEntryModule.name, () => {
    @Module({ imports: [] })
    class AppModule {}
    @Module({ imports: [] })
    class RootModule {}
    @Injectable()
    class NotAModule {}

    it("picks AppModule", () => {
      expect(
        selectEntryModule({ AppModule, RootModule }, undefined, "app.js", "/"),
      ).toEqual({ name: "AppModule", module: AppModule });
    });

    it("picks the export it is asked for", () => {
      expect(
        selectEntryModule({ AppModule, RootModule }, "RootModule", "app.js", "/"),
      ).toEqual({ name: "RootModule", module: RootModule });
    });

    it("picks the only exported module when there is no AppModule", () => {
      expect(
        selectEntryModule({ RootModule, NotAModule }, undefined, "app.js", "/"),
      ).toEqual({ name: "RootModule", module: RootModule });
      expect(selectEntryModule(RootModule, undefined, "app.js", "/")).toEqual({
        name: "default",
        module: RootModule,
      });
    });

    it("lists the exported modules when it cannot choose", () => {
      expect(() =>
        selectEntryModule(
          { RootModule, OtherModule: AppModule, NotAModule },
          undefined,
          "/project/dist/app.js",
          "/project",
        ),
      ).toThrow(
        "dist/app.js does not export AppModule. It exports these Nest modules: RootModule, OtherModule. Pass --module <name> to choose one.",
      );
    });

    it("says what the file does export when the requested one is missing", () => {
      expect(() =>
        selectEntryModule({ NotAModule }, "ApiModule", "/project/app.js", "/project"),
      ).toThrow(
        "app.js has no export named ApiModule. It exports no Nest module (a class decorated with @Module()). Pass --entry <file> and --module <name> for the file and export of your root module.",
      );
    });
  });

  describe(findProjectPackage.name, () => {
    it("finds the copy the project installed, wherever its entry point is", () => {
      write(
        "node_modules/nest-graph-inspector/package.json",
        JSON.stringify({
          name: "nest-graph-inspector",
          version: "9.9.9",
          main: "./dist/index.js",
          bin: { "nest-graph-inspector": "./dist/cli/bin.js" },
        }),
      );
      write("node_modules/nest-graph-inspector/dist/index.js");

      expect(
        findProjectPackage(createRequire(join(projectDir, "package.json"))),
      ).toEqual({
        root: join(projectDir, "node_modules/nest-graph-inspector"),
        version: "9.9.9",
        bin: join(projectDir, "node_modules/nest-graph-inspector/dist/cli/bin.js"),
      });
    });

    it("reports a copy without the CLI", () => {
      write(
        "node_modules/nest-graph-inspector/package.json",
        JSON.stringify({ name: "nest-graph-inspector", version: "0.3.0" }),
      );
      write("node_modules/nest-graph-inspector/index.js");

      expect(
        findProjectPackage(createRequire(join(projectDir, "package.json"))),
      ).toEqual({
        root: join(projectDir, "node_modules/nest-graph-inspector"),
        version: "0.3.0",
        bin: undefined,
      });
    });

    it("finds nothing when the project does not install it", () => {
      // Jest's createRequire resolves this workspace's own copy from anywhere,
      // which Node's does not, so this stands in for a project without one.
      const resolvesNothing = Object.assign(() => undefined, {
        resolve: (request: string) => {
          throw Object.assign(new Error(`Cannot find module '${request}'`), {
            code: "MODULE_NOT_FOUND",
          });
        },
      }) as unknown as NodeJS.Require;

      expect(findProjectPackage(resolvesNothing)).toBeUndefined();
    });
  });

  it("knows its own package", () => {
    const libDir = resolve(__dirname, "..", "..");

    expect(readOwnPackage()).toEqual(
      expect.objectContaining({
        root: libDir,
        bin: join(libDir, "dist/cli/bin.js"),
      }),
    );
  });

  it("loads a CommonJS entry with the project's require", async () => {
    const entry = write("dist/app.module.cjs", "exports.AppModule = 'loaded';");

    await expect(
      loadModule(entry, createRequire(join(projectDir, "package.json"))),
    ).resolves.toEqual({ AppModule: "loaded" });
  });
});
