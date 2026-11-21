import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Injectable, Module } from "@nestjs/common";
import { CliError } from "./cli-error";
import { displayPath } from "./files";
import {
  detectEntry,
  findProjectPackage,
  isEsModule,
  loadModule,
  readOwnPackage,
  resolveEntry,
  selectEntryModule,
  selectRootModule,
  type EntryRequest,
  type ResolvedEntry,
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
    // Resolved, as the paths the export loads are: on macOS tmpdir() is a link.
    projectDir = realpathSync(
      mkdtempSync(join(tmpdir(), "nest-graph-inspector-project-")),
    );
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

    it("reports a tsconfig it cannot read, rather than looking in the wrong place", () => {
      write("tsconfig.json", JSON.stringify({ extends: "./missing.json" }));
      write("dist/app.module.js");

      expect(() => detectEntry(projectDir, projectDir)).toThrow(
        /^Cannot read tsconfig\.json: .*missing\.json.*\. Fix it, or pass --entry <file>\.$/,
      );
    });

    it("asks for a build when the output directory has no app.module.js", () => {
      write("dist/main.js");

      expect(() => detectEntry(projectDir, resolve(projectDir, ".."))).toThrow(
        /^No app\.module\.js found under .*dist \(looked for .*app\.module\.js and .*src\/app\.module\.js\)\. Build your project first \(nest build\), or pass --entry <file>\.$/,
      );
    });
  });

  describe(resolveEntry.name, () => {
    const request = (overrides: Partial<EntryRequest> = {}): EntryRequest => ({
      projectDir,
      cwd: projectDir,
      entry: undefined,
      module: undefined,
      app: undefined,
      hasLoader: false,
      argv: ["export"],
      ...overrides,
    });
    const main = (imports: string, root: string) =>
      `import { NestFactory } from "@nestjs/core";\n${imports}\n\nvoid NestFactory.create(${root}).then((app) => app.listen(3000));\n`;
    /**
     * What the export warns of once it takes the root module export from the
     * loaded entry — classes standing in for the compiled module's exports.
     */
    const warningsFor = (entry: ResolvedEntry, moduleExports: Record<string, unknown>) =>
      selectRootModule(entry, moduleExports, projectDir).warnings;

    beforeEach(() => {
      write(
        "tsconfig.json",
        JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "dist" } }),
      );
      write("src/app.module.ts", "@Module({})\nexport class AppModule {}\n");
    });

    it("keeps to the app.module.js the convention finds, as it always has", () => {
      write("src/main.ts", main('import { AppModule } from "./app.module";', "AppModule"));
      const entry = write("dist/app.module.js", "exports.AppModule = class {};\n");

      const resolved = resolveEntry(request());

      expect(resolved).toMatchObject({
        origin: "convention",
        path: entry,
        moduleName: undefined,
      });
      expect(resolved.path).toBe(detectEntry(projectDir, projectDir));
      expect(resolved.origin === "convention" && resolved.check?.mainFile).toBe(
        join(projectDir, "src/main.ts"),
      );
      expect(warningsFor(resolved, { AppModule: class {} })).toEqual([]);
    });

    it("warns, and still keeps to the convention, when main.ts boots a module from another file", () => {
      write("src/main.ts", main('import { RootModule } from "./root.module";', "RootModule"));
      write("src/root.module.ts", "@Module({})\nexport class RootModule {}\n");
      const entry = write("dist/app.module.js", "exports.AppModule = class {};\n");
      write("dist/root.module.js", "exports.RootModule = class {};\n");

      const resolved = resolveEntry(request());

      expect(resolved).toMatchObject({ origin: "convention", path: entry });
      expect(warningsFor(resolved, { AppModule: class {} })).toEqual([
        "src/main.ts boots RootModule from src/root.module.ts, but the export uses dist/app.module.js (AppModule) by convention. Pass --entry dist/root.module.js --module RootModule to export RootModule.",
      ]);
    });

    it("warns when main.ts boots another export of the file the convention found, unless --module chose", () => {
      write(
        "src/app.module.ts",
        "@Module({})\nexport class AppModule {}\n\n@Module({})\nexport class RootModule {}\n",
      );
      write("src/main.ts", main('import { RootModule } from "./app.module";', "RootModule"));
      write("dist/app.module.js", "exports.AppModule = class {};\n");
      const moduleExports = { AppModule: class {}, RootModule: class {} };

      expect(warningsFor(resolveEntry(request()), moduleExports)).toEqual([
        "src/main.ts boots RootModule from src/app.module.ts, but the export uses dist/app.module.js (AppModule) by convention. Pass --module RootModule to export RootModule.",
      ]);
      expect(
        warningsFor(resolveEntry(request({ module: "AppModule" })), moduleExports),
      ).toEqual([]);
      expect(
        warningsFor(resolveEntry(request({ module: "RootModule" })), moduleExports),
      ).toEqual([]);
    });

    describe("a root module main.ts imports through a barrel", () => {
      const ROOT_MODULE = "@Module({})\nexport class RootModule {}\n";

      it.each([
        ["export { RootModule } from", { "src/modules/index.ts": 'export { RootModule } from "./root.module";\n' }],
        ["export * from", { "src/modules/index.ts": 'export * from "./root.module";\n' }],
        [
          "two barrels",
          {
            "src/modules/index.ts": 'export * from "./feature";\n',
            "src/modules/feature/index.ts": 'export { RootModule } from "../root.module";\n',
          },
        ],
      ])("follows %s to the class, and warns that the convention exports another", (_form, barrels) => {
        write("src/main.ts", main('import { RootModule } from "./modules";', "RootModule"));
        for (const [path, content] of Object.entries(barrels)) {
          write(path, content);
        }
        write("src/modules/root.module.ts", ROOT_MODULE);
        write("dist/modules/root.module.js", "exports.RootModule = class {};\n");
        const entry = write("dist/app.module.js", "exports.AppModule = class {};\n");

        const resolved = resolveEntry(request());

        expect(resolved).toMatchObject({ origin: "convention", path: entry });
        expect(warningsFor(resolved, { AppModule: class {} })).toEqual([
          "src/main.ts boots RootModule from src/modules/root.module.ts, but the export uses dist/app.module.js (AppModule) by convention. Pass --entry dist/modules/root.module.js --module RootModule to export RootModule.",
        ]);
      });

      it("names the class as its own file exports it, through export { X as Y }", () => {
        write("src/main.ts", main('import { RootModule } from "./modules";', "RootModule"));
        write("src/modules/index.ts", 'export { Root as RootModule } from "./root.module";\n');
        write("src/modules/root.module.ts", "@Module({})\nexport class Root {}\n");
        write("dist/modules/root.module.js", "exports.Root = class {};\n");
        write("dist/app.module.js", "exports.AppModule = class {};\n");

        expect(warningsFor(resolveEntry(request()), { AppModule: class {} })).toEqual([
          "src/main.ts boots Root from src/modules/root.module.ts, but the export uses dist/app.module.js (AppModule) by convention. Pass --entry dist/modules/root.module.js --module Root to export Root.",
        ]);
      });

      it("does not warn when the barrel re-exports the module the convention found", () => {
        // The barrel's target, which the check traces main.ts's import to.
        const source = write("src/app.module.ts", "@Module({})\nexport class AppModule {}\n");
        write("src/main.ts", main('import { AppModule } from "./modules";', "AppModule"));
        write("src/modules/index.ts", 'export { AppModule } from "../app.module";\n');
        const entry = write("dist/app.module.js", "exports.AppModule = class {};\n");

        const resolved = resolveEntry(request());

        expect(resolved.origin === "convention" && resolved.check).toMatchObject({
          root: { sourceFile: source, exportName: "AppModule" },
          compiled: [entry],
        });
        expect(warningsFor(resolved, { AppModule: class {} })).toEqual([]);
      });

      it("takes an explicit re-export of the name over an export * that has it too", () => {
        write("src/main.ts", main('import { RootModule } from "./modules";', "RootModule"));
        write(
          "src/modules/index.ts",
          'export * from "./other";\nexport { AppModule as RootModule } from "../app.module";\n',
        );
        write("src/modules/other.ts", ROOT_MODULE);
        write("dist/app.module.js", "exports.AppModule = class {};\n");

        const resolved = resolveEntry(request());

        expect(resolved.origin === "convention" && resolved.check?.root).toMatchObject({
          sourceFile: join(projectDir, "src/app.module.ts"),
          exportName: "AppModule",
        });
        expect(warningsFor(resolved, { AppModule: class {} })).toEqual([]);
      });

      it("takes export const RootModule = AppModule over an export * that has a RootModule too", () => {
        write("src/main.ts", main('import { RootModule } from "./modules";', "RootModule"));
        write(
          "src/modules/index.ts",
          'import { AppModule } from "../app.module";\n\nexport * from "./other";\nexport const RootModule = AppModule;\n',
        );
        write("src/modules/other.ts", ROOT_MODULE);
        write("dist/app.module.js", "exports.AppModule = class {};\n");

        const resolved = resolveEntry(request());

        expect(resolved.origin === "convention" && resolved.check?.root).toMatchObject({
          sourceFile: join(projectDir, "src/app.module.ts"),
          exportName: "AppModule",
        });
        expect(warningsFor(resolved, { AppModule: class {} })).toEqual([]);
      });

      it("stops at an exported value it cannot trace, rather than look through export *", () => {
        write("src/main.ts", main('import { RootModule } from "./modules";', "RootModule"));
        write(
          "src/modules/index.ts",
          'import { forRoot } from "./factory";\n\nexport * from "./other";\nexport const RootModule = forRoot();\n',
        );
        write("src/modules/other.ts", ROOT_MODULE);
        write("dist/app.module.js", "exports.AppModule = class {};\n");

        const resolved = resolveEntry(request());

        expect(resolved).toMatchObject({ origin: "convention", check: undefined });
        expect(warningsFor(resolved, { AppModule: class {} })).toEqual([]);
      });

      it("looks again, for another name, in a file one export * has been through", () => {
        write("src/main.ts", main('import { RootModule } from "./modules";', "RootModule"));
        write("src/modules/index.ts", 'export * from "./plain";\nexport * from "./renamed";\n');
        write("src/modules/plain.ts", 'export * from "./leaf";\n');
        write("src/modules/renamed.ts", 'export { Real as RootModule } from "./leaf";\n');
        write("src/modules/leaf.ts", "@Module({})\nexport class Real {}\n");
        write("dist/modules/leaf.js", "exports.Real = class {};\n");
        write("dist/app.module.js", "exports.AppModule = class {};\n");

        expect(warningsFor(resolveEntry(request()), { AppModule: class {} })).toEqual([
          "src/main.ts boots Real from src/modules/leaf.ts, but the export uses dist/app.module.js (AppModule) by convention. Pass --entry dist/modules/leaf.js --module Real to export Real.",
        ]);
      });

      it("follows an import the barrel exports again", () => {
        write("src/main.ts", main('import { RootModule } from "./modules";', "RootModule"));
        write("src/modules/index.ts", 'import { Real } from "./leaf";\n\nexport { Real as RootModule };\n');
        write("src/modules/leaf.ts", "@Module({})\nexport class Real {}\n");
        write("dist/modules/leaf.js", "exports.Real = class {};\n");
        write("dist/app.module.js", "exports.AppModule = class {};\n");

        expect(warningsFor(resolveEntry(request()), { AppModule: class {} })).toEqual([
          "src/main.ts boots Real from src/modules/leaf.ts, but the export uses dist/app.module.js (AppModule) by convention. Pass --entry dist/modules/leaf.js --module Real to export Real.",
        ]);
      });

      it("looks past a default-exported function of the name, which is no export of the name, to export *", () => {
        write("src/main.ts", main('import { RootModule } from "./modules";', "RootModule"));
        write(
          "src/modules/index.ts",
          'export * from "./root.module";\n\nexport default function RootModule(): void {}\n',
        );
        write("src/modules/root.module.ts", ROOT_MODULE);
        write("dist/modules/root.module.js", "exports.RootModule = class {};\n");
        write("dist/app.module.js", "exports.AppModule = class {};\n");

        expect(warningsFor(resolveEntry(request()), { AppModule: class {} })).toEqual([
          "src/main.ts boots RootModule from src/modules/root.module.ts, but the export uses dist/app.module.js (AppModule) by convention. Pass --entry dist/modules/root.module.js --module RootModule to export RootModule.",
        ]);
      });

      it("stops at a function exported under the name itself, rather than look through export *", () => {
        write("src/main.ts", main('import { RootModule } from "./modules";', "RootModule"));
        write(
          "src/modules/index.ts",
          'export * from "./root.module";\n\nexport function RootModule(): void {}\n',
        );
        write("src/modules/root.module.ts", ROOT_MODULE);
        write("dist/app.module.js", "exports.AppModule = class {};\n");

        const resolved = resolveEntry(request());

        expect(resolved).toMatchObject({ origin: "convention", check: undefined });
        expect(warningsFor(resolved, { AppModule: class {} })).toEqual([]);
      });

      it("gives up, quietly, on re-exports that go round in a circle", () => {
        write("src/main.ts", main('import { RootModule } from "./modules";', "RootModule"));
        write("src/modules/index.ts", 'export * from "./other";\n');
        write("src/modules/other.ts", 'export * from "./index";\n');
        const entry = write("dist/app.module.js", "exports.AppModule = class {};\n");

        const resolved = resolveEntry(request());

        expect(resolved).toMatchObject({ origin: "convention", path: entry, check: undefined });
        expect(warningsFor(resolved, { AppModule: class {} })).toEqual([]);
      });
    });

    it("takes --entry at its word and never reads main.ts", () => {
      // main.ts would be ambiguous, were it read.
      write(
        "src/main.ts",
        `${main('import { AppModule } from "./app.module";\nimport { WorkerModule } from "./worker.module";', "AppModule")}void NestFactory.create(WorkerModule);\n`,
      );
      write("src/worker.module.ts", "@Module({})\nexport class WorkerModule {}\n");
      const entry = write("dist/worker.module.js", "exports.WorkerModule = class {};\n");
      // The module object every reader shares — the CLI's own and TypeScript's
      // — rather than an import's frozen namespace.
      const nodeFs = require("node:fs") as typeof import("node:fs");
      const readFileSync = jest.spyOn(nodeFs, "readFileSync");

      try {
        expect(
          resolveEntry(request({ entry: "dist/worker.module.js", module: "WorkerModule" })),
        ).toEqual({ origin: "entry", path: entry, moduleName: "WorkerModule" });
        const read = readFileSync.mock.calls.map(([path]) => String(path));
        // The entry itself is read, to be checked before it is loaded.
        expect(read).toContain(entry);
        expect(read).not.toContain(join(projectDir, "src/main.ts"));
      } finally {
        readFileSync.mockRestore();
      }
    });

    it("lets --module override the module main.ts boots", () => {
      write("src/main.ts", main('import { MainModule } from "./main.module";', "MainModule"));
      write(
        "src/main.module.ts",
        "@Module({})\nexport class HelperModule {}\n\n@Module({})\nexport class MainModule {}\n",
      );
      const entry = write(
        "dist/main.module.js",
        "exports.HelperModule = class {};\nexports.MainModule = class {};\n",
      );

      expect(resolveEntry(request())).toMatchObject({
        origin: "main",
        path: entry,
        moduleName: "MainModule",
      });
      expect(resolveEntry(request({ module: "HelperModule" }))).toMatchObject({
        origin: "main",
        path: entry,
        moduleName: "HelperModule",
      });
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
      expect(
        selectEntryModule({ NotAModule, RootModule }, "NotAModule", "app.js", "/"),
      ).toEqual({ name: "NotAModule", module: NotAModule });
    });

    it("passes over an AppModule that is not a Nest module for the one that is", () => {
      expect(
        selectEntryModule(
          { AppModule: NotAModule, RootModule },
          undefined,
          "app.js",
          "/",
        ),
      ).toEqual({ name: "RootModule", module: RootModule });
    });

    it("still picks an AppModule whose @Module() is empty, with no other module to take", () => {
      // `@Module({})` defines no metadata, so it cannot be told from any
      // other class; with nothing else to choose, it is taken by its name.
      @Module({})
      class EmptyAppModule {}

      expect(
        selectEntryModule(
          { AppModule: EmptyAppModule, NotAModule },
          undefined,
          "app.js",
          "/",
        ),
      ).toEqual({ name: "AppModule", module: EmptyAppModule });
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

  it("tells ES modules from CommonJS the way Node does", () => {
    write("package.json", JSON.stringify({ type: "commonjs" }));
    write("esm/package.json", JSON.stringify({ type: "module" }));

    expect(isEsModule(join(projectDir, "dist/app.module.js"))).toBe(false);
    expect(isEsModule(join(projectDir, "esm/dist/app.module.js"))).toBe(true);
    expect(isEsModule(join(projectDir, "esm/dist/app.module.cjs"))).toBe(false);
    expect(isEsModule(join(projectDir, "dist/app.module.mjs"))).toBe(true);
    // A loader registered with --require decides for TypeScript.
    expect(isEsModule(join(projectDir, "esm/src/app.module.ts"))).toBe(false);
  });

  it("shows paths inside the current directory relative to it", () => {
    expect(displayPath("/project/dist/app.js", "/project")).toBe("dist/app.js");
    expect(displayPath("/project/..cache/app.js", "/project")).toBe(
      "..cache/app.js",
    );
    expect(displayPath("/elsewhere/app.js", "/project")).toBe(
      "/elsewhere/app.js",
    );
    expect(displayPath("/project", "/project")).toBe("/project");
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
