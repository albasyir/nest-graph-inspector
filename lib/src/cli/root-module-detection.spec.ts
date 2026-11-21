import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ts } from "ts-morph";
import { CliError, CliUsageError } from "./cli-error";
import { detectEntry, resolveEntry, type EntryRequest } from "./project";
import { findNestFactoryCall } from "./root-module-detection";

/**
 * How the export finds the root module without `--entry`: from main.ts, read
 * and never run. Every project here is files in a temporary directory, and
 * nothing in them is loaded.
 */

/** A module file, as written. */
function moduleSource(...names: string[]): string {
  return `import { Module } from "@nestjs/common";\n${names
    .map((name) => `\n@Module({})\nexport class ${name} {}\n`)
    .join("")}`;
}

/** The same, as tsc compiles it to CommonJS. */
function compiledModule(...names: string[]): string {
  return `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
${names
  .map(
    (name) => `let ${name} = class ${name} {};
${name} = __decorate([(0, common_1.Module)({})], ${name});
exports.${name} = ${name};
`,
  )
  .join("")}`;
}

/** A main.ts booting `boot`, with `imports` for its root module. */
function mainSource(imports: string, boot: string): string {
  return `import { NestFactory } from "@nestjs/core";
${imports}

async function bootstrap(): Promise<void> {
  const app = await ${boot};
  await app.listen(3000);
}

void bootstrap();
`;
}

/** main.ts as tsc compiles it: what `node dist/main.js` starts. */
const COMPILED_MAIN = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const app_module_1 = require("./app.module");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    await app.listen(3000);
}
void bootstrap();
`;

/** What webpack makes of main.ts: one file that starts the application. */
const WEBPACK_BUNDLE = `/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({
/***/ "@nestjs/core":
/***/ ((module) => { module.exports = require("@nestjs/core"); })
/******/ 	});
var __webpack_exports__ = {};
const _nestjs_core__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__("@nestjs/core");
async function bootstrap() {
    const app = await _nestjs_core__WEBPACK_IMPORTED_MODULE_0__.NestFactory.create(_app_module__WEBPACK_IMPORTED_MODULE_1__.AppModule);
    await app.listen(3000);
}
bootstrap();
/******/ })();
`;

const STANDARD_TSCONFIG = JSON.stringify({
  compilerOptions: {
    module: "commonjs",
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    rootDir: "src",
    outDir: "dist",
  },
});

describe("root module detection", () => {
  let projectDir: string;

  const at = (path: string) => join(projectDir, path);
  const write = (path: string, content = "") => {
    const file = at(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  const detect = (request: Partial<EntryRequest> = {}) =>
    resolveEntry({
      projectDir,
      cwd: projectDir,
      entry: undefined,
      module: undefined,
      app: undefined,
      hasLoader: false,
      argv: ["export"],
      ...request,
    });
  /** What the convention alone says, which is what the export said before it read main.ts. */
  const conventionError = (): Error => {
    try {
      detectEntry(projectDir, projectDir);
    } catch (error) {
      if (error instanceof Error) {
        return error;
      }
    }

    throw new Error("The convention found an entry");
  };

  /** A built project whose main.ts boots `RootModule` from root.module.ts. */
  const writeRootModuleProject = (main = mainSource(
    'import { RootModule } from "./root.module";',
    "NestFactory.create(RootModule)",
  )) => {
    write("tsconfig.json", STANDARD_TSCONFIG);
    write("src/main.ts", main);
    write("src/root.module.ts", moduleSource("RootModule"));
    write("dist/main.js", COMPILED_MAIN);
    return write("dist/root.module.js", compiledModule("RootModule"));
  };

  beforeEach(() => {
    projectDir = realpathSync(
      mkdtempSync(join(tmpdir(), "nest-graph-inspector-detection-")),
    );
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe("main.ts", () => {
    it("finds RootModule in root.module.ts, compiled to dist/root.module.js", () => {
      const compiled = writeRootModuleProject();

      expect(detect()).toEqual({
        origin: "main",
        path: compiled,
        moduleName: "RootModule",
        mainFile: at("src/main.ts"),
        notes: ["entry dist/root.module.js (RootModule, from src/main.ts)"],
        warnings: [],
      });
    });

    it("takes the module main.ts boots from a file that exports several", () => {
      write("tsconfig.json", STANDARD_TSCONFIG);
      write(
        "src/main.ts",
        mainSource(
          'import { MainModule } from "./main.module";',
          "NestFactory.create(MainModule)",
        ),
      );
      write("src/main.module.ts", moduleSource("HelperModule", "MainModule"));
      const compiled = write(
        "dist/main.module.js",
        compiledModule("HelperModule", "MainModule"),
      );

      expect(detect()).toMatchObject({
        origin: "main",
        path: compiled,
        moduleName: "MainModule",
      });
    });

    it.each([
      [
        "a named import",
        'import { RootModule } from "./root.module";',
        "NestFactory.create(RootModule)",
        "RootModule",
      ],
      [
        "an aliased import",
        'import { RootModule as Root } from "./root.module";',
        "NestFactory.create(Root)",
        "RootModule",
      ],
      [
        "a default import",
        'import Root from "./root.module";',
        "NestFactory.create(Root)",
        "default",
      ],
      [
        "a namespace import",
        'import * as modules from "./root.module";',
        "NestFactory.create(modules.RootModule)",
        "RootModule",
      ],
      [
        "import = require()",
        'import modules = require("./root.module");',
        "NestFactory.create(modules.RootModule)",
        "RootModule",
      ],
      [
        "a constant",
        'import { RootModule } from "./root.module";\nconst root = RootModule;',
        "NestFactory.create(root)",
        "RootModule",
      ],
    ])("follows %s", (_form, imports, boot, moduleName) => {
      const compiled = writeRootModuleProject(mainSource(imports, boot));

      expect(detect()).toMatchObject({ origin: "main", path: compiled, moduleName });
    });

    it("resolves a tsconfig paths alias", () => {
      write(
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            module: "commonjs",
            rootDir: "src",
            outDir: "dist",
            paths: { "@app/*": ["src/*"] },
          },
        }),
      );
      write(
        "src/main.ts",
        mainSource(
          'import { RootModule } from "@app/modules/root.module";',
          "NestFactory.create(RootModule)",
        ),
      );
      write("src/modules/root.module.ts", moduleSource("RootModule"));
      const compiled = write(
        "dist/modules/root.module.js",
        compiledModule("RootModule"),
      );

      expect(detect()).toMatchObject({
        origin: "main",
        path: compiled,
        moduleName: "RootModule",
      });
    });

    it('resolves an ES module specifier ending in .js to its .ts source, under "type": "module"', () => {
      write("package.json", JSON.stringify({ type: "module" }));
      write(
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            module: "nodenext",
            moduleResolution: "nodenext",
            rootDir: "src",
            outDir: "dist",
          },
        }),
      );
      write(
        "src/main.ts",
        mainSource(
          'import { RootModule } from "./root.module.js";',
          "NestFactory.create(RootModule)",
        ),
      );
      write("src/root.module.ts", moduleSource("RootModule"));
      const compiled = write(
        "dist/root.module.js",
        'export { RootModule } from "./elsewhere.js";\n',
      );

      expect(detect()).toMatchObject({ origin: "main", path: compiled });
    });

    it.each([
      [
        "create<NestFastifyApplication>(root, adapter)",
        mainSource(
          'import { RootModule } from "./root.module";\nimport { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";',
          "NestFactory.create<NestFastifyApplication>(RootModule, new FastifyAdapter())",
        ),
      ],
      [
        "createApplicationContext",
        mainSource(
          'import { RootModule } from "./root.module";',
          "NestFactory.createApplicationContext(RootModule)",
        ),
      ],
      [
        "createMicroservice",
        mainSource(
          'import { Transport } from "@nestjs/microservices";\nimport { RootModule } from "./root.module";',
          "NestFactory.createMicroservice(RootModule, { transport: Transport.TCP })",
        ),
      ],
      [
        "NestFactory imported under another name",
        `import { NestFactory as Factory } from "@nestjs/core";
import { RootModule } from "./root.module";

void Factory.create(RootModule).then((app) => app.listen(3000));
`,
      ],
      [
        "NestFactory through a namespace import",
        `import * as core from "@nestjs/core";
import { RootModule } from "./root.module";

async function bootstrap() {
  const app = await core.NestFactory.create(RootModule);
  await app.listen(3000);
}
void bootstrap();
`,
      ],
    ])("finds the root module booted with %s", (_call, main) => {
      const compiled = writeRootModuleProject(main);

      expect(detect()).toMatchObject({
        origin: "main",
        path: compiled,
        moduleName: "RootModule",
      });
    });

    it("reads the entry file and source root nest-cli.json names", () => {
      write("nest-cli.json", JSON.stringify({ sourceRoot: "app", entryFile: "server" }));
      write(
        "tsconfig.json",
        JSON.stringify({ compilerOptions: { rootDir: "app", outDir: "dist" } }),
      );
      write(
        "app/server.ts",
        mainSource(
          'import { ServerModule } from "./server.module";',
          "NestFactory.create(ServerModule)",
        ),
      );
      write("app/server.module.ts", moduleSource("ServerModule"));
      const compiled = write("dist/server.module.js", compiledModule("ServerModule"));

      expect(detect()).toEqual({
        origin: "main",
        path: compiled,
        moduleName: "ServerModule",
        mainFile: at("app/server.ts"),
        notes: ["entry dist/server.module.js (ServerModule, from app/server.ts)"],
        warnings: [],
      });
    });

    it("refuses a main.ts that declares its root module itself, loading nothing", () => {
      write("tsconfig.json", STANDARD_TSCONFIG);
      write(
        "src/main.ts",
        `import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

@Module({})
export class AppModule {}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}
void bootstrap();
`,
      );
      write("dist/main.js", COMPILED_MAIN);

      expect(() => detect()).toThrow(
        new CliError(
          "src/main.ts declares its root module AppModule itself, and loading src/main.ts would start the application, so the export will not load it. Move AppModule into a file of its own that src/main.ts imports, or pass --entry with a file that exports your root module and does not start the application.",
        ),
      );
    });

    describe("several boots", () => {
      beforeEach(() => {
        write("tsconfig.json", STANDARD_TSCONFIG);
        write(
          "src/main.ts",
          `import { NestFactory } from "@nestjs/core";
import { ApiModule } from "./api.module";
import { WorkerModule } from "./worker.module";

async function bootstrap() {
  const api = await NestFactory.create(ApiModule);
  const worker = await NestFactory.createMicroservice(WorkerModule, {});
  await Promise.all([api.listen(3000), worker.listen()]);
}
void bootstrap();
`,
        );
        write("src/api.module.ts", moduleSource("ApiModule"));
        write("src/worker.module.ts", moduleSource("WorkerModule"));
        write("dist/api.module.js", compiledModule("ApiModule"));
        write("dist/worker.module.js", compiledModule("WorkerModule"));
      });

      it("asks for --module when main.ts boots two different root modules", () => {
        expect(() => detect()).toThrow(
          new CliError(
            "src/main.ts boots 2 root modules (ApiModule, WorkerModule). Pass --module <name>.",
          ),
        );
      });

      it("takes the one --module names", () => {
        expect(detect({ module: "WorkerModule" })).toMatchObject({
          origin: "main",
          path: at("dist/worker.module.js"),
          moduleName: "WorkerModule",
        });
      });

      it("says so when --module names none of them", () => {
        expect(() => detect({ module: "OtherModule" })).toThrow(
          new CliError(
            "src/main.ts boots 2 root modules (ApiModule, WorkerModule), and none of them is OtherModule. Pass --module with one of them, or --entry <file> and --module <name>.",
          ),
        );
      });
    });

    it("counts one root module booted twice once", () => {
      const compiled = writeRootModuleProject(
        mainSource(
          'import { RootModule } from "./root.module";',
          "process.env.CLI ? NestFactory.createApplicationContext(RootModule) : NestFactory.create(RootModule)",
        ),
      );

      expect(detect()).toMatchObject({ path: compiled, moduleName: "RootModule" });
    });

    it("exports the module behind RootModule.forRoot(), and warns that its options are not", () => {
      const compiled = writeRootModuleProject(
        mainSource(
          'import { RootModule } from "./root.module";',
          'NestFactory.create(RootModule.forRoot({ url: process.env.DATABASE_URL }))',
        ),
      );

      expect(detect()).toMatchObject({
        origin: "main",
        path: compiled,
        moduleName: "RootModule",
        warnings: [
          "src/main.ts boots RootModule.forRoot(...); exporting RootModule without the options main.ts passes to it.",
        ],
      });
    });

    it.each([
      ["there is no main.ts", undefined],
      [
        "main.ts calls no NestFactory method",
        'import { bootstrap } from "./bootstrap";\n\nvoid bootstrap();\n',
      ],
      [
        "the root module is only known at runtime",
        mainSource(
          'import { rootModuleFor } from "./root-module-for";',
          "NestFactory.create(rootModuleFor(process.env.APP))",
        ),
      ],
      [
        "the root module comes from a package",
        mainSource(
          'import { HostModule } from "@acme/host";',
          "NestFactory.create(HostModule)",
        ),
      ],
    ])("fails as it always has when %s", (_case, main) => {
      write("tsconfig.json", STANDARD_TSCONFIG);
      write("dist/main.js", COMPILED_MAIN);
      if (main !== undefined) {
        write("src/main.ts", main);
      }

      const expected = conventionError();
      expect(expected.message).toBe(
        "No app.module.js found under dist (looked for dist/app.module.js and dist/src/app.module.js). Build your project first (nest build), or pass --entry <file>.",
      );
      expect(() => detect()).toThrow(expected);
    });

    it("fails as it always has when nothing is built and main.ts is missing", () => {
      expect(() => detect()).toThrow(
        new CliError(
          "No compiled application found: dist does not exist. Build your project first (nest build), or pass --entry <file>.",
        ),
      );
    });
  });

  describe("a Nest CLI monorepo", () => {
    const projects = {
      api: {
        type: "application",
        root: "apps/api",
        entryFile: "main",
        sourceRoot: "apps/api/src",
        compilerOptions: { tsConfigPath: "apps/api/tsconfig.app.json" },
      },
      worker: {
        type: "application",
        root: "apps/worker",
        entryFile: "main",
        sourceRoot: "apps/worker/src",
        compilerOptions: { tsConfigPath: "apps/worker/tsconfig.app.json" },
      },
      shared: {
        type: "library",
        root: "libs/shared",
        entryFile: "index",
        sourceRoot: "libs/shared/src",
        compilerOptions: { tsConfigPath: "libs/shared/tsconfig.lib.json" },
      },
    };
    const NOTE =
      "nest-cli.json defines applications api, worker; using the default project api (pass --app <name> for another)";

    /** Two applications and a library, as `nest generate app` and `nest generate library` lay them out. */
    const writeMonorepo = (topLevel: Record<string, unknown>) => {
      write("nest-cli.json", JSON.stringify({ ...topLevel, projects }));
      write(
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: {
            module: "commonjs",
            experimentalDecorators: true,
            paths: { "@app/shared": ["libs/shared/src"] },
          },
        }),
      );
      for (const [app, root] of [
        ["api", "ApiModule"],
        ["worker", "WorkerModule"],
      ] as const) {
        write(
          `apps/${app}/tsconfig.app.json`,
          JSON.stringify({
            extends: "../../tsconfig.json",
            compilerOptions: { outDir: `../../dist/apps/${app}` },
          }),
        );
        write(
          `apps/${app}/src/main.ts`,
          mainSource(
            `import { ${root} } from "./${app}.module";`,
            `NestFactory.create(${root})`,
          ),
        );
        write(
          `apps/${app}/src/${app}.module.ts`,
          `import { Module } from "@nestjs/common";
import { SharedModule } from "@app/shared";

@Module({ imports: [SharedModule] })
export class ${root} {}
`,
        );
      }
      write("libs/shared/src/index.ts", 'export * from "./shared.module";\n');
      write("libs/shared/src/shared.module.ts", moduleSource("SharedModule"));
    };
    const TSC_TOP_LEVEL = {
      monorepo: true,
      root: "apps/api",
      sourceRoot: "apps/api/src",
      compilerOptions: {
        builder: "tsc",
        tsConfigPath: "apps/api/tsconfig.app.json",
      },
    };
    /** Where tsc writes each application's root module: the project is its root directory. */
    const writeTscBuild = () => {
      write("dist/apps/api/apps/api/src/main.js", COMPILED_MAIN);
      write("dist/apps/api/apps/api/src/api.module.js", compiledModule("ApiModule"));
      write("dist/apps/worker/apps/worker/src/main.js", COMPILED_MAIN);
      write(
        "dist/apps/worker/apps/worker/src/worker.module.js",
        compiledModule("WorkerModule"),
      );
    };

    it("exports the default project, and says which it is", () => {
      writeMonorepo(TSC_TOP_LEVEL);
      writeTscBuild();

      expect(detect()).toEqual({
        origin: "main",
        path: at("dist/apps/api/apps/api/src/api.module.js"),
        moduleName: "ApiModule",
        mainFile: at("apps/api/src/main.ts"),
        notes: [
          NOTE,
          "entry dist/apps/api/apps/api/src/api.module.js (ApiModule, from apps/api/src/main.ts)",
        ],
        warnings: [],
      });
    });

    it("exports the application --app names", () => {
      writeMonorepo(TSC_TOP_LEVEL);
      writeTscBuild();

      expect(detect({ app: "worker" })).toEqual({
        origin: "main",
        path: at("dist/apps/worker/apps/worker/src/worker.module.js"),
        moduleName: "WorkerModule",
        mainFile: at("apps/worker/src/main.ts"),
        notes: [
          "entry dist/apps/worker/apps/worker/src/worker.module.js (WorkerModule, from apps/worker/src/main.ts)",
        ],
        warnings: [],
      });
    });

    it.each([
      [
        "nope",
        'nest-cli.json has no project "nope". Pass --app with one of: api, worker.',
      ],
      [
        "shared",
        '"shared" is a library, which has no main.ts. Pass --app with one of: api, worker.',
      ],
    ])("rejects --app %s as a usage error", (app, message) => {
      writeMonorepo(TSC_TOP_LEVEL);
      writeTscBuild();

      const run = () => detect({ app });
      expect(run).toThrow(CliUsageError);
      expect(run).toThrow(new CliUsageError(message));
    });

    it("asks for --app when the top level names no default project", () => {
      writeMonorepo({
        monorepo: true,
        compilerOptions: { builder: "tsc" },
      });
      writeTscBuild();

      expect(() => detect()).toThrow(
        new CliError(
          "nest-cli.json defines 2 applications (api, worker) and no default project. Pass --app <name>.",
        ),
      );
    });

    it("rejects --app for a project without projects", () => {
      writeRootModuleProject();
      write("nest-cli.json", JSON.stringify({ sourceRoot: "src" }));

      expect(() => detect({ app: "api" })).toThrow(
        new CliUsageError(
          "nest-cli.json defines no projects, so --app api has nothing to choose from. Run the export without --app.",
        ),
      );
    });

    it("never takes a compiled file from a bundled build, and names the command that loads the TypeScript source", () => {
      writeMonorepo({
        monorepo: true,
        root: "apps/api",
        sourceRoot: "apps/api/src",
        compilerOptions: {
          webpack: true,
          tsConfigPath: "apps/api/tsconfig.app.json",
        },
      });
      // A bundle, and a stale tsc build beside it.
      write("dist/apps/api/main.js", WEBPACK_BUNDLE);
      writeTscBuild();

      expect(() => detect({ app: "api", argv: ["export", "--app", "api"] })).toThrow(
        new CliError(
          "apps/api is built with webpack into one main.js, which starts the application when it is loaded. Its root module is ApiModule in apps/api/src/api.module.ts. Run: nest-graph-inspector export --app api --require ts-node/register --require tsconfig-paths/register",
        ),
      );
      expect(detect({ app: "api", hasLoader: true })).toMatchObject({
        origin: "main",
        path: at("apps/api/src/api.module.ts"),
        moduleName: "ApiModule",
      });
    });

    it("treats a monorepo that names no builder as bundled", () => {
      writeMonorepo({
        monorepo: true,
        root: "apps/api",
        sourceRoot: "apps/api/src",
        compilerOptions: { tsConfigPath: "apps/api/tsconfig.app.json" },
      });
      write("dist/apps/api/main.js", WEBPACK_BUNDLE);

      expect(() => detect()).toThrow(
        new CliError(
          "apps/api is built into one main.js — nest-cli.json names no builder, and the Nest CLI bundles a monorepo with webpack, or rspack from Nest CLI 12 — which starts the application when it is loaded. Its root module is ApiModule in apps/api/src/api.module.ts. Run: nest-graph-inspector export --require ts-node/register --require tsconfig-paths/register",
        ),
      );
    });
  });

  describe("a bundled build", () => {
    it.each([
      ["webpack", { builder: "webpack" }],
      // The bundler's configPath is its own config, never read as a tsconfig.
      ["rspack", { builder: { type: "rspack", options: { configPath: "rspack.config.js" } } }],
      ["webpack", { webpack: true }],
    ])("never takes a compiled file from a %s build", (bundler, compilerOptions) => {
      writeRootModuleProject();
      write("nest-cli.json", JSON.stringify({ compilerOptions }));
      write("rspack.config.js", "module.exports = { target: 'node' };\n");
      write("dist/main.js", WEBPACK_BUNDLE);

      expect(() =>
        detect({ argv: ["export", "--out", "graph output.json"] }),
      ).toThrow(
        new CliError(
          `The project is built with ${bundler} into one main.js, which starts the application when it is loaded. Its root module is RootModule in src/root.module.ts. Run: nest-graph-inspector export --out 'graph output.json' --require ts-node/register`,
        ),
      );
      expect(detect({ hasLoader: true })).toMatchObject({
        origin: "main",
        path: at("src/root.module.ts"),
        moduleName: "RootModule",
        notes: ["entry src/root.module.ts (RootModule, from src/main.ts)"],
      });
    });
  });

  describe("an application not built yet", () => {
    beforeEach(() => {
      write("tsconfig.json", STANDARD_TSCONFIG);
      write(
        "src/main.ts",
        mainSource(
          'import { RootModule } from "./root.module";',
          "NestFactory.create(RootModule)",
        ),
      );
      write("src/root.module.ts", moduleSource("RootModule"));
    });

    it("names the command that loads its TypeScript source", () => {
      expect(() => detect()).toThrow(
        new CliError(
          "No compiled RootModule found: src/main.ts boots it from src/root.module.ts, which has not been built to dist/root.module.js or dist/src/root.module.js. Build your project first (nest build), or run: nest-graph-inspector export --require ts-node/register",
        ),
      );
    });

    it("loads the TypeScript source with a --require loader", () => {
      expect(detect({ hasLoader: true })).toMatchObject({
        origin: "main",
        path: at("src/root.module.ts"),
        moduleName: "RootModule",
      });
    });

    it("still prefers the compiled file once there is one", () => {
      const compiled = write("dist/root.module.js", compiledModule("RootModule"));

      expect(detect({ hasLoader: true })).toMatchObject({ path: compiled });
    });
  });

  it("finds what SWC writes, which leaves the source root out of the path", () => {
    write("nest-cli.json", JSON.stringify({ compilerOptions: { builder: "swc" } }));
    // No rootDir: tsc would write dist/src/root.module.js.
    write("tsconfig.json", JSON.stringify({ compilerOptions: { outDir: "dist" } }));
    write(
      "src/main.ts",
      mainSource('import { RootModule } from "./root.module";', "NestFactory.create(RootModule)"),
    );
    write("src/root.module.ts", moduleSource("RootModule"));
    const compiled = write("dist/root.module.js", compiledModule("RootModule"));

    expect(detect()).toMatchObject({ origin: "main", path: compiled });
  });

  describe("files that start the application", () => {
    const STARTS =
      "starts the application (it calls NestFactory.create), so the export will not load it: loading it would run your bootstrap — listen on a port, connect to a database. Point --entry at the file that exports your root module (e.g. dist/app.module.js).";

    it("refuses --entry at main.js compiled by tsc", () => {
      write("dist/main.js", COMPILED_MAIN);

      expect(() => detect({ entry: "dist/main.js" })).toThrow(
        new CliError(`dist/main.js ${STARTS}`),
      );
    });

    it("refuses --entry at a webpack bundle, whatever its name", () => {
      write("dist/server-bundle.js", WEBPACK_BUNDLE);

      expect(() => detect({ entry: "dist/server-bundle.js" })).toThrow(
        new CliError(`dist/server-bundle.js ${STARTS}`),
      );
    });

    it("refuses --entry at the application's entry file, even when it calls NestFactory elsewhere", () => {
      write(
        "dist/main.js",
        '"use strict";\nrequire("./bootstrap").bootstrap();\n',
      );
      write("src/main.ts", 'import { bootstrap } from "./bootstrap";\nvoid bootstrap();\n');

      for (const entry of ["dist/main.js", "src/main.ts"]) {
        expect(() => detect({ entry, hasLoader: true })).toThrow(
          new CliError(
            `${entry} starts the application (it is the application's entry file), so the export will not load it: loading it would run your bootstrap — listen on a port, connect to a database. Point --entry at the file that exports your root module (e.g. dist/app.module.js).`,
          ),
        );
      }
    });

    it("loads --entry at a module file", () => {
      const entry = write("dist/app.module.js", compiledModule("AppModule"));

      expect(detect({ entry: "dist/app.module.js" })).toEqual({
        origin: "entry",
        path: entry,
        moduleName: undefined,
      });
    });

    it("refuses an app.module.js found by convention that starts the application", () => {
      write(
        "dist/app.module.js",
        `${compiledModule("AppModule")}require("@nestjs/core").NestFactory.create(AppModule);\n`,
      );

      expect(() => detect()).toThrow(
        new CliError(`dist/app.module.js ${STARTS}`),
      );
    });
  });

  describe(findNestFactoryCall.name, () => {
    const call = (text: string, fileName = "file.js") =>
      findNestFactoryCall(
        ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS),
      );

    it.each([
      ["NestFactory.create(AppModule)", "NestFactory.create"],
      ["core_1.NestFactory.createMicroservice(AppModule, {})", "NestFactory.createMicroservice"],
      ["(0, core_1.NestFactory.create)(AppModule)", "NestFactory.create"],
      ['require("@nestjs/core").NestFactory.createApplicationContext(AppModule)', "NestFactory.createApplicationContext"],
      ['NestFactory["create"](AppModule)', "NestFactory.create"],
      ["NestFactory[method](AppModule)", "NestFactory[…]"],
      ["NestFactory.create.call(NestFactory, AppModule)", "NestFactory.create"],
      ['import { NestFactory as F } from "@nestjs/core";\nF.create(AppModule);', "NestFactory.create"],
      ['const { NestFactory: F } = require("@nestjs/core");\nF.create(AppModule);', "NestFactory.create"],
      ['const F = require("@nestjs/core").NestFactory;\nconst G = F;\nG.create(AppModule);', "NestFactory.create"],
      ['const { create } = require("@nestjs/core").NestFactory;\ncreate(AppModule);', "NestFactory.create"],
      ['const { createMicroservice: boot } = NestFactory;\nboot(AppModule, {});', "NestFactory.createMicroservice"],
      ["const create = core_1.NestFactory.create;\ncreate.call(core_1.NestFactory, AppModule);", "NestFactory.create"],
      ["const create = NestFactory.create.bind(NestFactory);\ncreate(AppModule);", "NestFactory.create"],
    ])("finds %s", (text, expected) => {
      expect(call(text)).toBe(expected);
    });

    it.each([
      "exports.AppModule = AppModule;",
      "NestFactoryStub.create(AppModule);",
      "const factory = { create() {} };\nfactory.create(AppModule);",
      "const { create } = factory;\ncreate(AppModule);",
      "// NestFactory.create(AppModule)\nconst text = 'NestFactory.create(AppModule)';",
    ])("finds none in %j", (text) => {
      expect(call(text)).toBeUndefined();
    });
  });
});
