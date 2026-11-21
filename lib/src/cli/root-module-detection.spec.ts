import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Module } from "@nestjs/common";
import { ts } from "ts-morph";
import { CliError, CliUsageError } from "./cli-error";
import { findNestFactoryCall } from "./load-guard";
import { detectEntry, resolveEntry, selectEntryModule, type EntryRequest } from "./project";

/**
 * How the export finds the root module without `--entry`: from main.ts, read
 * and never run. Every project here is files in a temporary directory, and
 * nothing in them is loaded.
 */

function moduleSource(...names: string[]): string {
  return `import { Module } from "@nestjs/common";\n${names
    .map((name) => `\n@Module({})\nexport class ${name} {}\n`)
    .join("")}`;
}

/** As tsc compiles `moduleSource` to CommonJS. */
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

function defaultModuleSource(name: string): string {
  return `import { Module } from "@nestjs/common";\n\n@Module({})\nexport default class ${name} {}\n`;
}

function compiledDefaultModule(name: string): string {
  return `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
let ${name} = class ${name} {};
${name} = __decorate([(0, common_1.Module)({})], ${name});
exports.default = ${name};
`;
}

/** A compiled fixture's export shape — each `exports.<name> =` as a Nest module — read rather than loaded. */
function exportsOf(path: string): Record<string, unknown> {
  return Object.fromEntries(
    [...readFileSync(path, "utf8").matchAll(/^exports\.(\w+) = /gm)].map(([, name]) => {
      const module = class {};
      Module({ imports: [] })(module);
      return [name, module];
    }),
  );
}

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

const ROOT_IMPORT = 'import { RootModule } from "./root.module";';
const ROOT_MAIN = mainSource(ROOT_IMPORT, "NestFactory.create(RootModule)");

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

/** A compiled main.js that boots through a function it imports, calling no NestFactory itself. */
const BOOTSTRAPPING_MAIN = '"use strict";\nrequire("./bootstrap").bootstrap();\n';

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

const DIST_TSCONFIG = JSON.stringify({ compilerOptions: { outDir: "dist" } });

const NODENEXT_TSCONFIG = JSON.stringify({
  compilerOptions: { module: "nodenext", moduleResolution: "nodenext", rootDir: "src", outDir: "dist" },
});

const swcConfig = (options: Record<string, unknown>, settings: Record<string, unknown> = {}) =>
  JSON.stringify({ ...settings, compilerOptions: { builder: { type: "swc", options } } });

const startsTheApplication = (file: string, reason: string) =>
  `${file} starts the application (${reason}), so the export will not load it: loading it would run your bootstrap — listen on a port, connect to a database. Point --entry at the file that exports your root module (e.g. dist/app.module.js).`;

const ENTRY_FILE = "it is the application's entry file";

describe("root module detection", () => {
  let projectDir: string;

  const at = (path: string) => join(projectDir, path);
  const write = (path: string, content = "") => {
    const file = at(path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  };
  const writeAll = (files: Readonly<Record<string, string>>) => {
    for (const [path, content] of Object.entries(files)) {
      write(path, content);
    }
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

  /** A built project whose main.ts — none for `null` — boots `RootModule` from root.module.ts, by its name or as its default. */
  const writeRootModuleProject = (
    main: string | null = ROOT_MAIN,
    exportName: "RootModule" | "default" = "RootModule",
  ) => {
    const byDefault = exportName === "default";
    write("tsconfig.json", STANDARD_TSCONFIG);
    if (main !== null) {
      write("src/main.ts", main);
    }
    write("src/root.module.ts", byDefault ? defaultModuleSource("RootModule") : moduleSource("RootModule"));
    write("dist/main.js", COMPILED_MAIN);
    return write(
      "dist/root.module.js",
      byDefault ? compiledDefaultModule("RootModule") : compiledModule("RootModule"),
    );
  };

  beforeEach(() => {
    projectDir = realpathSync(mkdtempSync(join(tmpdir(), "nest-graph-inspector-detection-")));
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

    it.each<[string, string, string, "RootModule" | "default"]>([
      ["a named import", ROOT_IMPORT, "NestFactory.create(RootModule)", "RootModule"],
      ["an aliased import", 'import { RootModule as Root } from "./root.module";', "NestFactory.create(Root)", "RootModule"],
      ["a default import", 'import Root from "./root.module";', "NestFactory.create(Root)", "default"],
      ["a namespace import", 'import * as modules from "./root.module";', "NestFactory.create(modules.RootModule)", "RootModule"],
      ["import = require()", 'import modules = require("./root.module");', "NestFactory.create(modules.RootModule)", "RootModule"],
      ["a constant", `${ROOT_IMPORT}\nconst root = RootModule;`, "NestFactory.create(root)", "RootModule"],
      ["three constants", `${ROOT_IMPORT}\nconst a = RootModule;\nconst b = a;\nconst c = b;`, "NestFactory.create(c)", "RootModule"],
      ["a property of require() under another name", 'const { RootModule: Root } = require("./root.module");', "NestFactory.create(Root)", "RootModule"],
    ])("follows %s", (_form, imports, boot, moduleName) => {
      const compiled = writeRootModuleProject(mainSource(imports, boot), moduleName);

      const resolved = detect();
      expect(resolved).toMatchObject({ origin: "main", path: compiled, moduleName });
      // A name the compiled file does export, so the export takes it.
      expect(
        selectEntryModule(exportsOf(compiled), resolved.moduleName, compiled, projectDir).name,
      ).toBe(moduleName);
    });

    /** A main.ts that boots RootModule through `boot`, after `helper` calls create() on something else. */
    const shadowing = (imports: string, helper: string, boot: string) => `${imports}
import { HelperModule } from "./helper.module";
${ROOT_IMPORT}

type Factory = { create(module: unknown): unknown };
declare const fakes: { NestFactory: Factory };

${helper}

async function bootstrap() {
  const app = await ${boot};
  await app.listen(3000);
}
void bootstrap();
`;

    it.each([
      [
        "with create<NestFastifyApplication>(root, adapter)",
        mainSource(
          `${ROOT_IMPORT}\nimport { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";`,
          "NestFactory.create<NestFastifyApplication>(RootModule, new FastifyAdapter())",
        ),
      ],
      ["with createApplicationContext", mainSource(ROOT_IMPORT, "NestFactory.createApplicationContext(RootModule)")],
      [
        "with createMicroservice",
        mainSource(
          `import { Transport } from "@nestjs/microservices";\n${ROOT_IMPORT}`,
          "NestFactory.createMicroservice(RootModule, { transport: Transport.TCP })",
        ),
      ],
      [
        "through NestFactory imported under another name",
        `import { NestFactory as Factory } from "@nestjs/core";\n${ROOT_IMPORT}\n\nvoid Factory.create(RootModule).then((app) => app.listen(3000));\n`,
      ],
      [
        "through a namespace import of @nestjs/core",
        `import * as core from "@nestjs/core";\n${ROOT_IMPORT}\n\nvoid core.NestFactory.create(RootModule).then((app) => app.listen(3000));\n`,
      ],
      [
        "through a default import of @nestjs/core",
        `import core from "@nestjs/core";\n${ROOT_IMPORT}\n\nvoid core.NestFactory.create(RootModule);\n`,
      ],
      [
        "through NestFactory destructured from require()",
        'const { NestFactory } = require("@nestjs/core");\nconst { RootModule } = require("./root.module");\n\nvoid NestFactory.create(RootModule).then((app) => app.listen(3000));\n',
      ],
      [
        "through import core = require()",
        `import core = require("@nestjs/core");\n${ROOT_IMPORT}\n\nvoid core.NestFactory.create(RootModule).then((app) => app.listen(3000));\n`,
      ],
      [
        "through an alias of NestFactory, which keeps its receiver",
        `import { NestFactory } from "@nestjs/core";\n${ROOT_IMPORT}\n\nconst Factory = NestFactory;\nvoid Factory.create(RootModule).then((app) => app.listen(3000));\n`,
      ],
      [
        "through a let alias of NestFactory nothing assigns again",
        `import { NestFactory } from "@nestjs/core";\n${ROOT_IMPORT}\n\nlet Factory = NestFactory;\nvoid Factory.create(RootModule).then((app) => app.listen(3000));\n`,
      ],
      [
        "through a dynamic import()",
        `${ROOT_IMPORT}\n\nasync function bootstrap() {\n  const { NestFactory } = await import("@nestjs/core");\n  const app = await NestFactory.create(RootModule);\n  await app.listen(3000);\n}\nvoid bootstrap();\n`,
      ],
      // A heuristic over the syntax, not a claim that the call boots: Nest's
      // create() reads `this`, so called without its receiver it throws.
      [
        "through a method destructured from NestFactory",
        `import { NestFactory } from "@nestjs/core";\n${ROOT_IMPORT}\n\nconst { create } = NestFactory;\nvoid create(RootModule);\n`,
      ],
      [
        "through an alias of an alias that is declared below its use",
        `import { NestFactory } from "@nestjs/core";\n${ROOT_IMPORT}\n\nconst boot = () => {\n  const Factory = Core;\n  return Factory.create(RootModule);\n};\nconst Core = NestFactory;\nvoid boot();\n`,
      ],
      [
        "twice, counted once",
        mainSource(
          ROOT_IMPORT,
          "process.env.CLI ? NestFactory.createApplicationContext(RootModule) : NestFactory.create(RootModule)",
        ),
      ],
      [
        "beside a create() on a NestFactory of main.ts's own, which is no second root module",
        `import { NestFactory } from "@nestjs/core";\n${ROOT_IMPORT}\nimport { HelperModule } from "./helper.module";\nimport { tools } from "./tools";\n\nasync function bootstrap() {\n  tools.NestFactory.create(HelperModule);\n  const app = await NestFactory.create(RootModule);\n  await app.listen(3000);\n}\nvoid bootstrap();\n`,
      ],
      [
        "beside a call through a function's parameter that shadows the import",
        shadowing(
          'import * as core from "@nestjs/core";',
          "export function warmUp(core: typeof fakes) {\n  core.NestFactory.create(HelperModule);\n}",
          "core.NestFactory.create(RootModule)",
        ),
      ],
      [
        "beside a call through an arrow function's parameter that shadows the import",
        shadowing(
          'import { NestFactory } from "@nestjs/core";',
          "export const warmUp = (NestFactory: Factory) => NestFactory.create(HelperModule);",
          "NestFactory.create(RootModule)",
        ),
      ],
      [
        "beside a call through a catch clause's variable that shadows the import",
        shadowing(
          'import { NestFactory } from "@nestjs/core";',
          'try {\n  JSON.parse("");\n} catch (NestFactory) {\n  (NestFactory as Factory).create(HelperModule);\n}',
          "NestFactory.create(RootModule)",
        ),
      ],
      [
        "beside a call through a block's const that shadows the import",
        shadowing(
          'import { NestFactory as F } from "@nestjs/core";',
          "{\n  const F = fakes.NestFactory;\n  F.create(HelperModule);\n}",
          "F.create(RootModule)",
        ),
      ],
      [
        "beside a call through a function's var, declared after its use, that shadows the import",
        shadowing(
          'import * as core from "@nestjs/core";',
          "export function warmUp() {\n  core.NestFactory.create(HelperModule);\n  var core = fakes;\n}",
          "core.NestFactory.create(RootModule)",
        ),
      ],
      [
        "beside a call through a let alias of NestFactory assigned something else",
        shadowing(
          'import { NestFactory } from "@nestjs/core";',
          "let Factory = NestFactory;\nFactory = fakes.NestFactory as typeof NestFactory;\nvoid Factory.create(HelperModule);",
          "NestFactory.create(RootModule)",
        ),
      ],
      [
        "beside a call through a parameter named require",
        shadowing(
          'import { NestFactory } from "@nestjs/core";',
          'export function warmUp(require: (id: string) => typeof fakes) {\n  require("@nestjs/core").NestFactory.create(HelperModule);\n}',
          "NestFactory.create(RootModule)",
        ),
      ],
    ])("finds the root module booted %s", (_call, main) => {
      const compiled = writeRootModuleProject(main);
      write("src/helper.module.ts", moduleSource("HelperModule"));
      write("dist/helper.module.js", compiledModule("HelperModule"));

      expect(detect()).toMatchObject({ origin: "main", path: compiled, moduleName: "RootModule" });
      // A boot main.ts's analysis counts, the load guard refuses.
      expect(findNestFactoryCall(ts.createSourceFile("main.ts", main, ts.ScriptTarget.Latest))).toBeDefined();
    });

    it.each<[string, Record<string, string>, { path: string; moduleName: string; mainFile?: string }]>([
      [
        "a tsconfig paths alias",
        {
          "tsconfig.json": JSON.stringify({
            compilerOptions: { module: "commonjs", rootDir: "src", outDir: "dist", paths: { "@app/*": ["src/*"] } },
          }),
          "src/main.ts": mainSource('import { RootModule } from "@app/modules/root.module";', "NestFactory.create(RootModule)"),
          "src/modules/root.module.ts": moduleSource("RootModule"),
          "dist/modules/root.module.js": compiledModule("RootModule"),
        },
        { path: "dist/modules/root.module.js", moduleName: "RootModule" },
      ],
      [
        'an ES module specifier ending in .js to its .ts source, under "type": "module"',
        {
          "package.json": JSON.stringify({ type: "module" }),
          "tsconfig.json": NODENEXT_TSCONFIG,
          "src/main.ts": mainSource('import { RootModule } from "./root.module.js";', "NestFactory.create(RootModule)"),
          "src/root.module.ts": moduleSource("RootModule"),
          "dist/root.module.js": 'export { RootModule } from "./elsewhere.js";\n',
        },
        { path: "dist/root.module.js", moduleName: "RootModule" },
      ],
      [
        "import = require() in an .mts main.ts as require does, in CommonJS mode, without an extension",
        {
          "tsconfig.json": NODENEXT_TSCONFIG,
          "src/main.mts": `import { NestFactory } from "@nestjs/core";\nimport modules = require("./root.module");\n\nvoid NestFactory.create(modules.RootModule).then((app) => app.listen(3000));\n`,
          "src/root.module.ts": moduleSource("RootModule"),
          "dist/root.module.js": compiledModule("RootModule"),
        },
        { path: "dist/root.module.js", moduleName: "RootModule", mainFile: "src/main.mts" },
      ],
      [
        "an import in an .mts main.ts in its own ESM mode, given the extension",
        {
          "tsconfig.json": NODENEXT_TSCONFIG,
          "src/main.mts": `import { NestFactory } from "@nestjs/core";\nimport { RootModule } from "./root.module.js";\n\nvoid NestFactory.create(RootModule).then((app) => app.listen(3000));\n`,
          "src/root.module.ts": moduleSource("RootModule"),
          "dist/root.module.js": compiledModule("RootModule"),
        },
        { path: "dist/root.module.js", moduleName: "RootModule", mainFile: "src/main.mts" },
      ],
      [
        "a .tsx main.ts",
        {
          "tsconfig.json": STANDARD_TSCONFIG,
          "src/main.tsx": ROOT_MAIN,
          "src/root.module.ts": moduleSource("RootModule"),
          "dist/root.module.js": compiledModule("RootModule"),
        },
        { path: "dist/root.module.js", moduleName: "RootModule", mainFile: "src/main.tsx" },
      ],
      [
        "the module main.ts boots from a file that exports several",
        {
          "tsconfig.json": STANDARD_TSCONFIG,
          "src/main.ts": mainSource('import { MainModule } from "./main.module";', "NestFactory.create(MainModule)"),
          "src/main.module.ts": moduleSource("HelperModule", "MainModule"),
          "dist/main.module.js": compiledModule("HelperModule", "MainModule"),
        },
        { path: "dist/main.module.js", moduleName: "MainModule" },
      ],
    ])("resolves %s", (_case, files, expected) => {
      writeAll(files);

      expect(detect()).toMatchObject({
        origin: "main",
        path: at(expected.path),
        moduleName: expected.moduleName,
        ...(expected.mainFile === undefined ? {} : { mainFile: at(expected.mainFile) }),
      });
    });

    it("reads the entry file and source root nest-cli.json names", () => {
      write("nest-cli.json", JSON.stringify({ sourceRoot: "app", entryFile: "server" }));
      write("tsconfig.json", JSON.stringify({ compilerOptions: { rootDir: "app", outDir: "dist" } }));
      write("app/server.ts", mainSource('import { ServerModule } from "./server.module";', "NestFactory.create(ServerModule)"));
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

    it.each([
      [
        "a class it decorates itself",
        'import { Module } from "@nestjs/common";\nimport { NestFactory } from "@nestjs/core";\n\n@Module({})\nexport class AppModule {}\n\nasync function bootstrap() {\n  const app = await NestFactory.create(AppModule);\n  await app.listen(3000);\n}\nvoid bootstrap();\n',
      ],
      [
        "a class expression it holds in a const",
        'import { NestFactory } from "@nestjs/core";\n\nconst AppModule = class {};\n\nvoid NestFactory.create(AppModule);\n',
      ],
    ])("refuses a main.ts that declares its root module itself, as %s, loading nothing", (_form, main) => {
      write("tsconfig.json", STANDARD_TSCONFIG);
      write("src/main.ts", main);
      write("dist/main.js", COMPILED_MAIN);

      expect(() => detect()).toThrow(
        new CliError(
          "src/main.ts declares its root module AppModule itself, and loading src/main.ts would start the application, so the export will not load it. Move AppModule into a file of its own that src/main.ts imports, or pass --entry with a file that exports your root module and does not start the application.",
        ),
      );
    });

    describe("several root modules", () => {
      const TWO_ROOTS = `import { NestFactory } from "@nestjs/core";
import { ApiModule } from "./api.module";
import { WorkerModule } from "./worker.module";

async function bootstrap() {
  const api = await NestFactory.create(ApiModule);
  const worker = await NestFactory.createMicroservice(WorkerModule, {});
  await Promise.all([api.listen(3000), worker.listen()]);
}
void bootstrap();
`;
      const ONE_NAME = `import { NestFactory } from "@nestjs/core";
import { RootModule as Api } from "./api/root.module";
import { RootModule as Worker } from "./worker/root.module";

async function bootstrap() {
  const api = await NestFactory.create(Api);
  const worker = await NestFactory.createApplicationContext(Worker);
  await Promise.all([api.listen(3000), worker.init()]);
}
void bootstrap();
`;
      const CONSTS = `import { NestFactory } from "@nestjs/core";
import { ApiModule } from "./api.module";
import { WorkerModule } from "./worker.module";

const Api = ApiModule;
const Worker = WorkerModule;

async function bootstrap() {
  const api = await NestFactory.create(Api);
  const worker = await NestFactory.createMicroservice(Worker, {});
  await Promise.all([api.listen(3000), worker.listen()]);
}
void bootstrap();
`;
      const BOTH = "RootModule from src/api/root.module.ts, RootModule from src/worker/root.module.ts";

      beforeEach(() => {
        write("tsconfig.json", STANDARD_TSCONFIG);
        for (const [source, name] of [
          ["api.module", "ApiModule"],
          ["worker.module", "WorkerModule"],
          ["api/root.module", "RootModule"],
          ["worker/root.module", "RootModule"],
        ]) {
          write(`src/${source}.ts`, moduleSource(name));
          write(`dist/${source}.js`, compiledModule(name));
        }
      });

      it.each<[string, string, string | undefined, { path: string; moduleName: string } | string]>([
        ["two, without --module", TWO_ROOTS, undefined, "src/main.ts boots 2 root modules (ApiModule, WorkerModule). Pass --module <name>."],
        ["two, by the one --module names", TWO_ROOTS, "WorkerModule", { path: "dist/worker.module.js", moduleName: "WorkerModule" }],
        [
          "two, when --module names neither",
          TWO_ROOTS,
          "OtherModule",
          "src/main.ts boots 2 root modules (ApiModule, WorkerModule), and none of them is OtherModule. Pass --module with one of them, or --entry <file> and --module <name>.",
        ],
        [
          "two of one name, when --module names both, rather than take the first",
          ONE_NAME,
          "RootModule",
          `src/main.ts boots 2 root modules named RootModule (${BOTH}). Pass --entry <file> and --module RootModule for the one to export.`,
        ],
        ["two of one name, by the import alias --module names", ONE_NAME, "Worker", { path: "dist/worker/root.module.js", moduleName: "RootModule" }],
        ["two of one name, without --module", ONE_NAME, undefined, `src/main.ts boots 2 root modules (${BOTH}). Pass --entry <file> and --module <name>.`],
        ["two through consts, by the const's name", CONSTS, "Worker", { path: "dist/worker.module.js", moduleName: "WorkerModule" }],
        ["two through consts, by the class's name", CONSTS, "WorkerModule", { path: "dist/worker.module.js", moduleName: "WorkerModule" }],
        [
          "two through consts, listed by the names their files export them under",
          CONSTS,
          undefined,
          "src/main.ts boots 2 root modules (ApiModule, WorkerModule). Pass --module <name>.",
        ],
      ])("chooses among %s", (_case, main, module, expected) => {
        write("src/main.ts", main);

        if (typeof expected === "string") {
          expect(() => detect({ module })).toThrow(new CliError(expected));
        } else {
          expect(detect({ module })).toMatchObject({ origin: "main", path: at(expected.path), moduleName: expected.moduleName });
        }
      });
    });

    it.each([
      ["a const that shadows an import", "", "  const RootModule = WorkerModule;", "RootModule"],
      ["a let nothing assigns again", "let root = WorkerModule;", "", "root"],
    ])("follows %s to the module it holds, in its own scope", (_case, declarations, local, argument) => {
      write("tsconfig.json", STANDARD_TSCONFIG);
      write("src/api.module.ts", moduleSource("ApiModule"));
      write("src/worker.module.ts", moduleSource("WorkerModule"));
      write("dist/api.module.js", compiledModule("ApiModule"));
      write("dist/worker.module.js", compiledModule("WorkerModule"));
      write(
        "src/main.ts",
        `import { NestFactory } from "@nestjs/core";
import { ApiModule as RootModule } from "./api.module";
import { WorkerModule } from "./worker.module";
${declarations}

async function bootstrap() {
${local}
  const app = await NestFactory.create(${argument});
  await app.listen(3000);
}
void bootstrap();
`,
      );

      expect(detect()).toMatchObject({ origin: "main", path: at("dist/worker.module.js"), moduleName: "WorkerModule" });
    });

    it.each([
      ["directly", ROOT_IMPORT, "NestFactory.create(RootModule.forRoot({ url: process.env.DATABASE_URL }))"],
      [
        "through a const, named as the class rather than the const",
        `${ROOT_IMPORT}\n\nconst Root = RootModule.forRoot({ url: process.env.DATABASE_URL });`,
        "NestFactory.create(Root)",
      ],
    ])("exports the module behind RootModule.forRoot(), booted %s, and warns that its options are not", (_case, imports, boot) => {
      const compiled = writeRootModuleProject(mainSource(imports, boot));

      expect(detect()).toMatchObject({
        origin: "main",
        path: compiled,
        moduleName: "RootModule",
        warnings: [
          "src/main.ts boots RootModule.forRoot(...); exporting RootModule without the options main.ts passes to it.",
        ],
      });
    });

    it("says which boots it passed over, by line, when another decides", () => {
      const compiled = writeRootModuleProject(`import { NestFactory } from "@nestjs/core";
import { HostModule } from "@acme/host";
${ROOT_IMPORT}
import { rootFor } from "./root-for";

async function bootstrap() {
  const context = await NestFactory.createApplicationContext(
    rootFor(process.env.APP ?? "an application name long enough to be cut short"),
    { logger: false },
  );
  await context.close();
  await NestFactory.create(HostModule);
  const app = await NestFactory.create(RootModule);
  await app.listen(3000);
}
void bootstrap();
`);

      expect(detect()).toEqual({
        origin: "main",
        path: compiled,
        moduleName: "RootModule",
        mainFile: at("src/main.ts"),
        notes: [
          "entry dist/root.module.js (RootModule, from src/main.ts)",
          'skipped src/main.ts:7 NestFactory.createApplicationContext(rootFor(process.env.APP ?? "an application…: its root module is not an import the export can follow',
          "skipped src/main.ts:12 NestFactory.create(HostModule): its root module is not an import the export can follow",
        ],
        warnings: [],
      });
    });

    const main = (text: string) => ({ "src/main.ts": text });
    /** main.ts holding `root` as `declarations` say, and booting it. */
    const holding = (declarations: string) =>
      main(mainSource(`import { OtherModule, RootModule } from "./root.module";\n${declarations}`, "NestFactory.create(root)"));

    it.each<[string, Record<string, string>]>([
      ["there is no main.ts", {}],
      ["main.ts calls no NestFactory method", main('import { bootstrap } from "./bootstrap";\n\nvoid bootstrap();\n')],
      [
        "the root module is only known at runtime",
        main(mainSource('import { rootModuleFor } from "./root-module-for";', "NestFactory.create(rootModuleFor(process.env.APP))")),
      ],
      ["the root module comes from a package", main(mainSource('import { HostModule } from "@acme/host";', "NestFactory.create(HostModule)"))],
      ["NestFactory is imported from elsewhere", main(`import { NestFactory } from "./testing";\n${ROOT_IMPORT}\n\nvoid NestFactory.create(RootModule);\n`)],
      [
        "NestFactory is an object of main.ts's own",
        main(`${ROOT_IMPORT}\n\nconst factories = { NestFactory: { create: (module: unknown) => module } };\nfactories.NestFactory.create(RootModule);\n`),
      ],
      [
        "NestFactory is a parameter that shadows the import",
        main(`import { NestFactory } from "@nestjs/core";\n${ROOT_IMPORT}\n\nexport function boot(NestFactory: { create(module: unknown): unknown }) {\n  return NestFactory.create(RootModule);\n}\n`),
      ],
      ["NestFactory belongs to a namespace import of another module", main(`import * as other from "./other";\n${ROOT_IMPORT}\n\nvoid other.NestFactory.create(RootModule);\n`)],
      ["NestFactory belongs to import = require() of another module", main(`import other = require("./other");\n${ROOT_IMPORT}\n\nvoid other.NestFactory.create(RootModule);\n`)],
      ["the call is on another member of @nestjs/core", main(`import * as core from "@nestjs/core";\n${ROOT_IMPORT}\n\nvoid core.Other.create(RootModule);\n`)],
      ["NestFactory.create is called through .call()", main(`import { NestFactory } from "@nestjs/core";\n${ROOT_IMPORT}\n\nvoid NestFactory.create.call(NestFactory, RootModule);\n`)],
      [
        "the root module is required from a computed path",
        main('import { NestFactory } from "@nestjs/core";\nconst modules = require(process.env.ROOT_MODULE ?? "./root.module");\n\nvoid NestFactory.create(modules.RootModule);\n'),
      ],
      ["the root module is held by a let assigned again", holding("let root = RootModule;\nroot = OtherModule;")],
      ["the root module is held by a var declared twice", holding("var root = RootModule;\nvar root = OtherModule;")],
      ["the root module is held by a let written with ++", holding("let root = RootModule;\nroot++;")],
      ["the root module is held by a let written by for…of", holding("let root = RootModule;\nfor (root of [OtherModule]) {}")],
      ["the root module is held by a let written by a destructuring assignment", holding("let root = RootModule;\n({ root } = { root: OtherModule });")],
      ["the root module is held by a let written by a renaming destructuring assignment", holding("let root = RootModule;\n({ other: root } = { other: OtherModule });")],
      ["the root module is held by a let written by an array destructuring", holding("let root = RootModule;\n[root] = [OtherModule];")],
      ["the root module is held by a let written by a compound assignment", holding("let root = RootModule;\nroot ||= OtherModule;")],
      ["the root module is four constants away", holding("const a = RootModule;\nconst b = a;\nconst c = b;\nconst root = c;")],
      [
        "an .mts main.ts imports it in ESM mode without the extension a relative path needs",
        {
          "tsconfig.json": NODENEXT_TSCONFIG,
          "src/main.mts": `import { NestFactory } from "@nestjs/core";\n${ROOT_IMPORT}\n\nvoid NestFactory.create(RootModule).then((app) => app.listen(3000));\n`,
        },
      ],
    ])("fails as it always has when %s", (_case, files) => {
      writeRootModuleProject(null);
      writeAll(files);

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
    const API_ENTRY = "dist/apps/api/apps/api/src/api.module.js";
    const WORKER_ENTRY = "dist/apps/worker/apps/worker/src/worker.module.js";

    /** Two applications and a library, as `nest generate app` and `nest generate library` lay them out. */
    const writeMonorepo = (topLevel: Record<string, unknown>) => {
      write("nest-cli.json", JSON.stringify({ ...topLevel, projects }));
      write(
        "tsconfig.json",
        JSON.stringify({
          compilerOptions: { module: "commonjs", experimentalDecorators: true, paths: { "@app/shared": ["libs/shared/src"] } },
        }),
      );
      for (const [app, root] of [
        ["api", "ApiModule"],
        ["worker", "WorkerModule"],
      ] as const) {
        write(
          `apps/${app}/tsconfig.app.json`,
          JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { outDir: `../../dist/apps/${app}` } }),
        );
        write(`apps/${app}/src/main.ts`, mainSource(`import { ${root} } from "./${app}.module";`, `NestFactory.create(${root})`));
        write(
          `apps/${app}/src/${app}.module.ts`,
          `import { Module } from "@nestjs/common";\nimport { SharedModule } from "@app/shared";\n\n@Module({ imports: [SharedModule] })\nexport class ${root} {}\n`,
        );
      }
      write("libs/shared/src/index.ts", 'export * from "./shared.module";\n');
      write("libs/shared/src/shared.module.ts", moduleSource("SharedModule"));
    };
    const TSC_TOP_LEVEL = {
      monorepo: true,
      root: "apps/api",
      sourceRoot: "apps/api/src",
      compilerOptions: { builder: "tsc", tsConfigPath: "apps/api/tsconfig.app.json" },
    };
    /** Where tsc writes each application's root module: the project is its root directory. */
    const writeTscBuild = () => {
      write("dist/apps/api/apps/api/src/main.js", COMPILED_MAIN);
      write(API_ENTRY, compiledModule("ApiModule"));
      write("dist/apps/worker/apps/worker/src/main.js", COMPILED_MAIN);
      write(WORKER_ENTRY, compiledModule("WorkerModule"));
    };

    it.each([
      ["a tsc builder", TSC_TOP_LEVEL],
      [
        "no builder, which the Nest CLI builds with tsc",
        { monorepo: true, root: "apps/api", sourceRoot: "apps/api/src", compilerOptions: { tsConfigPath: "apps/api/tsconfig.app.json" } },
      ],
    ])("exports the default project, saying which it is, and the application --app names, built by %s", (_case, topLevel) => {
      writeMonorepo(topLevel);
      writeTscBuild();

      expect(detect()).toEqual({
        origin: "main",
        path: at(API_ENTRY),
        moduleName: "ApiModule",
        mainFile: at("apps/api/src/main.ts"),
        notes: [NOTE, `entry ${API_ENTRY} (ApiModule, from apps/api/src/main.ts)`],
        warnings: [],
      });
      expect(detect({ app: "worker" })).toEqual({
        origin: "main",
        path: at(WORKER_ENTRY),
        moduleName: "WorkerModule",
        mainFile: at("apps/worker/src/main.ts"),
        notes: [`entry ${WORKER_ENTRY} (WorkerModule, from apps/worker/src/main.ts)`],
        warnings: [],
      });
    });

    it.each([
      ["nope", 'nest-cli.json has no project "nope". Pass --app with one of: api, worker.'],
      ["shared", '"shared" is a library, which has no main.ts. Pass --app with one of: api, worker.'],
    ])("rejects --app %s as a usage error", (app, message) => {
      writeMonorepo(TSC_TOP_LEVEL);
      writeTscBuild();

      const run = () => detect({ app });
      expect(run).toThrow(CliUsageError);
      expect(run).toThrow(new CliUsageError(message));
    });

    it("asks for --app when the top level names no default project", () => {
      writeMonorepo({ monorepo: true, compilerOptions: { builder: "tsc" } });
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

    /** ts-node and tsconfig-paths read tsconfig.json unless TS_NODE_PROJECT names the one the application builds with. */
    const bundledApi = (bundler: string, file = "main.js", app = " --app api") =>
      `apps/api is built with ${bundler} into one ${file}, which starts the application when it is loaded. Its root module is ApiModule in apps/api/src/api.module.ts. Run: TS_NODE_PROJECT=apps/api/tsconfig.app.json nest-graph-inspector export${app} --require ts-node/register --require tsconfig-paths/register`;

    it("never takes a compiled file from a bundled build, and names the command that loads the TypeScript source", () => {
      writeMonorepo({ ...TSC_TOP_LEVEL, compilerOptions: { webpack: true, tsConfigPath: "apps/api/tsconfig.app.json" } });
      // A bundle, and a stale tsc build beside it.
      write("dist/apps/api/main.js", WEBPACK_BUNDLE);
      writeTscBuild();

      expect(() => detect({ app: "api", argv: ["export", "--app", "api"] })).toThrow(new CliError(bundledApi("webpack")));
      expect(detect({ app: "api", hasLoader: true })).toMatchObject({
        origin: "main",
        path: at("apps/api/src/api.module.ts"),
        moduleName: "ApiModule",
      });
    });

    it('treats the "builder": "rspack" nest g app writes as a bundle', () => {
      writeMonorepo({ ...TSC_TOP_LEVEL, compilerOptions: { builder: "rspack", tsConfigPath: "apps/api/tsconfig.app.json" } });
      write("dist/apps/api/main.js", WEBPACK_BUNDLE);

      expect(() => detect()).toThrow(new CliError(bundledApi("rspack", "main.js", "")));
    });

    it("takes webpack: true from the top level, unless --app's project sets its own", () => {
      const topLevel = { ...TSC_TOP_LEVEL, compilerOptions: { ...TSC_TOP_LEVEL.compilerOptions, webpack: true } };
      writeMonorepo(topLevel);
      writeTscBuild();
      // `webpack` wins over the builder; worker turns it off for itself.
      write(
        "nest-cli.json",
        JSON.stringify({
          ...topLevel,
          projects: {
            ...projects,
            worker: { ...projects.worker, compilerOptions: { ...projects.worker.compilerOptions, webpack: false } },
          },
        }),
      );

      expect(() => detect({ app: "api", argv: ["export", "--app", "api"] })).toThrow(new CliError(bundledApi("webpack")));
      expect(detect({ app: "worker" })).toMatchObject({ origin: "main", path: at(WORKER_ENTRY), moduleName: "WorkerModule" });
    });

    it("builds the default project from the top level alone; the project it matches only names it", () => {
      writeMonorepo(TSC_TOP_LEVEL);
      writeTscBuild();
      // The project api sets its own entry file and builder, which only
      // `nest build api` — and --app api — use.
      write(
        "nest-cli.json",
        JSON.stringify({
          ...TSC_TOP_LEVEL,
          projects: {
            ...projects,
            api: { ...projects.api, entryFile: "server", compilerOptions: { ...projects.api.compilerOptions, builder: "webpack" } },
          },
        }),
      );
      write("apps/api/src/server.ts", mainSource('import { ApiModule } from "./api.module";', "NestFactory.create(ApiModule)"));

      expect(detect()).toEqual({
        origin: "main",
        path: at(API_ENTRY),
        moduleName: "ApiModule",
        mainFile: at("apps/api/src/main.ts"),
        notes: [NOTE, `entry ${API_ENTRY} (ApiModule, from apps/api/src/main.ts)`],
        warnings: [],
      });
      expect(() => detect({ app: "api", argv: ["export", "--app", "api"] })).toThrow(
        new CliError(bundledApi("webpack", "server.js")),
      );
    });

    describe("an entry found by convention", () => {
      it("says which application it is, without --app", () => {
        writeMonorepo(TSC_TOP_LEVEL);
        const entry = write("dist/apps/api/apps/api/src/app.module.js", compiledModule("AppModule"));

        expect(detect()).toMatchObject({ origin: "convention", path: entry, notes: [NOTE] });
        expect(detect({ app: "api" })).toMatchObject({ origin: "convention", path: entry, notes: [] });
      });

      it("says nothing in a project of one application", () => {
        const entry = write("dist/app.module.js", compiledModule("AppModule"));

        expect(detect()).toMatchObject({ origin: "convention", path: entry, notes: [] });
      });
    });

    describe("applications built into one outDir", () => {
      /** api and worker, both built with the project's tsconfig into dist/. */
      const writeSharedOutDir = (topLevel: Record<string, unknown>) => {
        write(
          "nest-cli.json",
          JSON.stringify({
            monorepo: true,
            ...topLevel,
            compilerOptions: { builder: "tsc" },
            projects: {
              api: { type: "application", root: "apps/api", sourceRoot: "apps/api/src" },
              worker: { type: "application", root: "apps/worker", sourceRoot: "apps/worker/src" },
            },
          }),
        );
        write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs", rootDir: ".", outDir: "dist" } }));
        write("apps/api/src/main.ts", mainSource('import { AppModule } from "./app.module";', "NestFactory.create(AppModule)"));
        write("apps/api/src/app.module.ts", moduleSource("AppModule"));
        write("apps/worker/src/main.ts", mainSource('import { WorkerModule } from "./worker.module";', "NestFactory.create(WorkerModule)"));
        write("apps/worker/src/worker.module.ts", moduleSource("WorkerModule"));
        // Only api has an app.module.js.
        write("dist/apps/api/src/app.module.js", compiledModule("AppModule"));
        write("dist/apps/worker/src/worker.module.js", compiledModule("WorkerModule"));
      };
      const DEFAULT_PROJECT = { root: "apps/api", sourceRoot: "apps/api/src" };

      it("never takes another application's app.module.js for --app", () => {
        writeSharedOutDir(DEFAULT_PROJECT);
        // Where tsc, with rootDir ".", writes no app.module.js: an older
        // build's, or another application's.
        write("dist/app.module.js", compiledModule("AppModule"));

        expect(detect({ app: "worker" })).toEqual({
          origin: "main",
          path: at("dist/apps/worker/src/worker.module.js"),
          moduleName: "WorkerModule",
          mainFile: at("apps/worker/src/main.ts"),
          notes: ["entry dist/apps/worker/src/worker.module.js (WorkerModule, from apps/worker/src/main.ts)"],
          warnings: [],
        });
      });

      it("takes --app's own app.module.js under its source root", () => {
        writeSharedOutDir(DEFAULT_PROJECT);
        const entry = write("dist/apps/worker/src/app.module.js", compiledModule("AppModule"));

        expect(detect({ app: "worker" })).toMatchObject({ origin: "convention", path: entry });
      });

      it("says, when the default project is not plainly the one the convention found, which file it is", () => {
        writeSharedOutDir(DEFAULT_PROJECT);
        rmSync(at("dist/apps/api"), { recursive: true });
        const entry = write("dist/apps/worker/src/app.module.js", compiledModule("AppModule"));

        expect(detect()).toMatchObject({
          origin: "convention",
          path: entry,
          notes: [
            "nest-cli.json defines applications api, worker; using dist/apps/worker/src/app.module.js, found by convention (pass --app <name> for another)",
          ],
        });
      });

      it("says the default project's name when the file is its own, and which file it is with no default project", () => {
        writeSharedOutDir(DEFAULT_PROJECT);
        const entry = at("dist/apps/api/src/app.module.js");

        expect(detect()).toMatchObject({ origin: "convention", path: entry, notes: [NOTE] });

        writeSharedOutDir({});
        expect(detect()).toMatchObject({
          origin: "convention",
          path: entry,
          notes: [
            "nest-cli.json defines applications api, worker; using dist/apps/api/src/app.module.js, found by convention (pass --app <name> for another)",
          ],
        });
      });

      it("never takes, for --app, a path another application's build could write too", () => {
        writeSharedOutDir(DEFAULT_PROJECT);
        // tsc now infers its root directory, so each application's
        // app.module.js could be flattened into dist/ — either's.
        write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs", outDir: "dist" } }));
        write("dist/app.module.js", compiledModule("AppModule"));

        expect(detect({ app: "worker" })).toMatchObject({
          origin: "main",
          path: at("dist/apps/worker/src/worker.module.js"),
          moduleName: "WorkerModule",
        });
      });
    });

    describe("--app's own app.module.js, where its build writes it", () => {
      it("takes only the path tsc writes under an explicit rootDir, never a stale flattened one", () => {
        writeMonorepo(TSC_TOP_LEVEL);
        // worker's rootDir is apps/, and its outDir its own.
        write(
          "apps/worker/tsconfig.app.json",
          JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { rootDir: "..", outDir: "../../dist/worker" } }),
        );
        write("dist/worker/worker/src/worker.module.js", compiledModule("WorkerModule"));
        // From an older build: tsc writes app.module.js to dist/worker/worker/src/ now.
        write("dist/worker/app.module.js", compiledModule("AppModule"));

        expect(detect({ app: "worker" })).toMatchObject({
          origin: "main",
          path: at("dist/worker/worker/src/worker.module.js"),
          moduleName: "WorkerModule",
        });

        const entry = write("dist/worker/worker/src/app.module.js", compiledModule("AppModule"));
        expect(detect({ app: "worker" })).toMatchObject({ origin: "convention", path: entry });
      });

      it("takes the flattened <outDir>/app.module.js where tsc can write it, its outDir its own", () => {
        writeMonorepo(TSC_TOP_LEVEL);
        const entry = write("dist/apps/worker/app.module.js", compiledModule("AppModule"));

        expect(detect({ app: "worker" })).toMatchObject({ origin: "convention", path: entry });
      });

      it("says where it looked, when main.ts leaves nothing to follow either", () => {
        writeMonorepo(TSC_TOP_LEVEL);
        rmSync(at("apps/worker/src/main.ts"));

        expect(() => detect({ app: "worker" })).toThrow(
          new CliError(
            "No compiled app.module.js found for worker (looked for dist/apps/worker/src/app.module.js, dist/apps/worker/apps/worker/src/app.module.js, dist/apps/worker/app.module.js). Build worker first (nest build worker), or pass --entry <file>.",
          ),
        );
      });

      it("names worker's own build command when its root module is not built", () => {
        writeMonorepo(TSC_TOP_LEVEL);

        expect(() => detect({ app: "worker", argv: ["export", "--app", "worker"] })).toThrow(
          new CliError(
            "No compiled WorkerModule found: apps/worker/src/main.ts boots it from apps/worker/src/worker.module.ts, which has not been built to dist/apps/worker/src/worker.module.js or dist/apps/worker/apps/worker/src/worker.module.js or dist/apps/worker/worker.module.js. Build worker first (nest build worker), or run: TS_NODE_PROJECT=apps/worker/tsconfig.app.json nest-graph-inspector export --app worker --require ts-node/register --require tsconfig-paths/register",
          ),
        );
      });
    });

    describe("a root module file at one path in each application", () => {
      // api and worker each boot RootModule from their own root.module.ts, and
      // tsc, its root directory inferred, can write either to dist/.
      beforeEach(() => {
        const application = (app: string) => ({ type: "application", root: `apps/${app}`, sourceRoot: `apps/${app}/src` });
        write(
          "nest-cli.json",
          JSON.stringify({
            monorepo: true,
            root: "apps/api",
            sourceRoot: "apps/api/src",
            compilerOptions: { builder: "tsc" },
            projects: { api: application("api"), worker: application("worker") },
          }),
        );
        write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs", outDir: "dist" } }));
        for (const app of ["api", "worker"]) {
          write(`apps/${app}/src/main.ts`, ROOT_MAIN);
          write(`apps/${app}/src/root.module.ts`, moduleSource("RootModule"));
        }
        // One of them built, flattened: whose, nothing tells.
        write("dist/root.module.js", compiledModule("RootModule"));
      });

      it("will not take, for --app, a file another application's build writes too", () => {
        expect(() => detect({ app: "worker", argv: ["export", "--app", "worker"] })).toThrow(
          new CliError(
            "apps/worker/src/main.ts boots RootModule from apps/worker/src/root.module.ts, built to dist/root.module.js — but another application's apps/api/src/root.module.ts builds to dist/root.module.js too, so whose it is cannot be told. Pass --entry with the file to load, or load the TypeScript source: nest-graph-inspector export --app worker --require ts-node/register",
          ),
        );
      });

      it("loads the application's own TypeScript source instead, given a loader", () => {
        expect(detect({ app: "worker", hasLoader: true })).toMatchObject({
          origin: "main",
          path: at("apps/worker/src/root.module.ts"),
        });
      });

      it("takes a file only the application's own build writes", () => {
        // The flattened file gone: beside it, worker's would be one of two.
        rmSync(at("dist/root.module.js"));
        const compiled = write("dist/apps/worker/src/root.module.js", compiledModule("RootModule"));

        expect(detect({ app: "worker" })).toMatchObject({ origin: "main", path: compiled });
      });

      it("takes neither of two files worker's build could have written, before asking whose either is", () => {
        write("dist/apps/worker/src/root.module.js", compiledModule("RootModule"));

        expect(() => detect({ app: "worker", argv: ["export", "--app", "worker"] })).toThrow(
          new CliError(
            "apps/worker/src/main.ts boots RootModule from apps/worker/src/root.module.ts, which has been built to dist/apps/worker/src/root.module.js and dist/root.module.js: each is where a build from a different root directory writes it, so all but one of them are left from older builds. Pass --entry with the current one, build again into an emptied outDir, or run: nest-graph-inspector export --app worker --require ts-node/register",
          ),
        );
      });

      it("will not take it for the default project either", () => {
        expect(() => detect()).toThrow(
          /another application's apps\/worker\/src\/root\.module\.ts builds to dist\/root\.module\.js too/,
        );
      });
    });

    /** api and worker, each with a tsconfig.app.json of its own that `compilerOptions` completes. */
    const writeOwnTsConfigs = (
      compilerOptions: Record<"api" | "worker", Record<string, unknown>>,
      builders: Partial<Record<"api" | "worker", unknown>> = {},
    ) => {
      const application = (app: "api" | "worker") => ({
        type: "application",
        root: `apps/${app}`,
        sourceRoot: `apps/${app}/src`,
        compilerOptions: {
          tsConfigPath: `apps/${app}/tsconfig.app.json`,
          ...(builders[app] === undefined ? {} : { builder: builders[app] }),
        },
      });
      write(
        "nest-cli.json",
        JSON.stringify({
          monorepo: true,
          root: "apps/api",
          sourceRoot: "apps/api/src",
          compilerOptions: { builder: "tsc", tsConfigPath: "apps/api/tsconfig.app.json" },
          projects: { api: application("api"), worker: application("worker") },
        }),
      );
      write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs" } }));
      for (const app of ["api", "worker"] as const) {
        write(
          `apps/${app}/tsconfig.app.json`,
          JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: compilerOptions[app], include: ["src/**/*"] }),
        );
      }
    };

    it("will not take, for --app, a file another build writes from a source at another path", () => {
      // api's rootDir is apps/api, worker's apps/worker/src, and both write to
      // dist/: api's src/root.module.ts and worker's src/src/root.module.ts
      // both become dist/src/root.module.js. Only api has been built.
      writeOwnTsConfigs({ api: { rootDir: ".", outDir: "../../dist" }, worker: { rootDir: "src", outDir: "../../dist" } });
      write("apps/api/src/main.ts", ROOT_MAIN);
      write("apps/api/src/root.module.ts", moduleSource("RootModule"));
      write("apps/worker/src/main.ts", mainSource('import { RootModule } from "./src/root.module";', "NestFactory.create(RootModule)"));
      write("apps/worker/src/src/root.module.ts", moduleSource("RootModule"));
      write("dist/src/root.module.js", compiledModule("RootModule"));

      expect(() => detect({ app: "worker", argv: ["export", "--app", "worker"] })).toThrow(
        new CliError(
          "apps/worker/src/main.ts boots RootModule from apps/worker/src/src/root.module.ts, built to dist/src/root.module.js — but another application's apps/api/src/root.module.ts builds to dist/src/root.module.js too, so whose it is cannot be told. Pass --entry with the file to load, or load the TypeScript source: TS_NODE_PROJECT=apps/worker/tsconfig.app.json nest-graph-inspector export --app worker --require ts-node/register",
        ),
      );
      expect(detect({ app: "worker", hasLoader: true })).toMatchObject({
        origin: "main",
        path: at("apps/worker/src/src/root.module.ts"),
      });
    });

    it("takes a file a bundled application's build could not have written, though it has a source at that path", () => {
      // api built by tsc into dist/, worker by webpack into one main.js: only
      // tsc writes a dist/root.module.js.
      writeOwnTsConfigs(
        { api: { rootDir: "src", outDir: "../../dist" }, worker: { rootDir: "src", outDir: "../../dist" } },
        { worker: "webpack" },
      );
      for (const app of ["api", "worker"]) {
        write(`apps/${app}/src/main.ts`, ROOT_MAIN);
        write(`apps/${app}/src/root.module.ts`, moduleSource("RootModule"));
      }
      const compiled = write("dist/root.module.js", compiledModule("RootModule"));

      expect(detect({ app: "api" })).toMatchObject({ origin: "main", path: compiled });
    });

    describe("--app's app.module.js built by SWC in both layouts, one of them another application's path", () => {
      // worker, the default project, is built by SWC from src/ with rootDir
      // ".", so Nest CLI 12 writes dist/src/ and Nest CLI 11 dist/; api's tsc,
      // its rootDir apps/api/src, writes dist/ too.
      beforeEach(() => {
        const swc = { builder: "swc", tsConfigPath: "tsconfig.json" };
        write(
          "nest-cli.json",
          JSON.stringify({
            monorepo: true,
            root: "",
            sourceRoot: "src",
            compilerOptions: swc,
            projects: {
              worker: { type: "application", root: "", sourceRoot: "src", compilerOptions: swc },
              api: {
                type: "application",
                root: "apps/api",
                sourceRoot: "apps/api/src",
                compilerOptions: { builder: "tsc", tsConfigPath: "apps/api/tsconfig.app.json" },
              },
            },
          }),
        );
        write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs", rootDir: ".", outDir: "dist" } }));
        write("apps/api/tsconfig.app.json", JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { rootDir: "src" } }));
        write("src/main.ts", mainSource('import { WorkerModule } from "./worker.module";', "NestFactory.create(WorkerModule)"));
        write("src/worker.module.ts", moduleSource("WorkerModule"));
        write("dist/worker.module.js", compiledModule("WorkerModule"));
      });

      it("takes neither, before setting aside the one another application's build could write", () => {
        write("dist/src/app.module.js", compiledModule("AppModule"));
        write("dist/app.module.js", compiledModule("AppModule"));

        expect(detect({ app: "worker" })).toMatchObject({
          origin: "main",
          path: at("dist/worker.module.js"),
          moduleName: "WorkerModule",
        });
      });

      it("takes the one there is when it is worker's alone", () => {
        const entry = write("dist/src/app.module.js", compiledModule("AppModule"));

        expect(detect({ app: "worker" })).toMatchObject({ origin: "convention", path: entry });
      });

      it("takes, of one, none another application's build could write too, and says why when main.ts gives nothing to follow", () => {
        write("dist/app.module.js", compiledModule("AppModule"));
        expect(detect({ app: "worker" })).toMatchObject({ origin: "main", path: at("dist/worker.module.js") });

        rmSync(at("src/main.ts"));
        expect(() => detect({ app: "worker" })).toThrow(
          new CliError(
            "dist/app.module.js is where worker's build writes its app.module.js, but another application's build writes its own there too, so whose it is cannot be told. Pass --entry <file>.",
          ),
        );
      });

      it("says which files, when main.ts gives nothing to follow either", () => {
        write("dist/src/app.module.js", compiledModule("AppModule"));
        write("dist/app.module.js", compiledModule("AppModule"));
        rmSync(at("src/main.ts"));

        expect(() => detect({ app: "worker" })).toThrow(
          new CliError(
            "SWC has built worker's app.module.js to both dist/src/app.module.js and dist/app.module.js: Nest CLI 12 and Nest CLI 11 lay out its output differently, so one of them is left from an older build. Pass --entry with the current one, or build again into an emptied outDir.",
          ),
        );
      });
    });

    describe("--app's app.module.js, which another application's build can compile a source outside its sourceRoot to", () => {
      // worker's tsc, its rootDir ".", writes src/app.module.ts to dist/src/;
      // api's sourceRoot is apps/api/server, but its rootDir, apps/api, puts
      // apps/api/src/app.module.ts at dist/src/app.module.js as well.
      beforeEach(() => {
        write(
          "nest-cli.json",
          JSON.stringify({
            monorepo: true,
            root: "",
            sourceRoot: "src",
            projects: {
              worker: { type: "application", root: "", sourceRoot: "src" },
              api: {
                type: "application",
                root: "apps/api",
                sourceRoot: "apps/api/server",
                compilerOptions: { tsConfigPath: "apps/api/tsconfig.app.json" },
              },
            },
          }),
        );
        write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs", rootDir: ".", outDir: "dist" } }));
        write("apps/api/tsconfig.app.json", JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { rootDir: "." } }));
        write("src/main.ts", mainSource('import { WorkerModule } from "./worker.module";', "NestFactory.create(WorkerModule)"));
        write("src/worker.module.ts", moduleSource("WorkerModule"));
        write("dist/src/worker.module.js", compiledModule("WorkerModule"));
        write("dist/src/app.module.js", compiledModule("AppModule"));
      });

      it.each<[string, Record<string, string>, { origin: string; path: string }]>([
        [
          "falls back on main.ts while api's apps/api/src/app.module.ts compiles to it too",
          { "apps/api/src/app.module.ts": moduleSource("AppModule") },
          { origin: "main", path: "dist/src/worker.module.js" },
        ],
        ["still takes it while nothing of api's compiles to it", {}, { origin: "convention", path: "dist/src/app.module.js" }],
      ])("%s", (_case, files, expected) => {
        writeAll(files);

        expect(detect({ app: "worker" })).toMatchObject({ origin: expected.origin, path: at(expected.path) });
      });
    });
  });

  describe("a bundled build", () => {
    it.each([
      ["webpack", { builder: "webpack" }],
      // The bundler's configPath is its own config, which the application is
      // never built with.
      ["rspack", { builder: { type: "rspack", options: { configPath: "rspack.config.js" } } }],
      ["webpack", { webpack: true }],
    ])("never takes a compiled file from a %s build", (bundler, compilerOptions) => {
      writeRootModuleProject();
      write("nest-cli.json", JSON.stringify({ compilerOptions }));
      write("rspack.config.js", "module.exports = { target: 'node' };\n");
      write("dist/main.js", WEBPACK_BUNDLE);

      expect(() => detect({ argv: ["export", "--out", "graph output.json"] })).toThrow(
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

    it("names the bundle after the entry file", () => {
      write("nest-cli.json", JSON.stringify({ entryFile: "server", compilerOptions: { builder: "webpack" } }));
      write("tsconfig.json", STANDARD_TSCONFIG);
      write("src/server.ts", ROOT_MAIN);
      write("src/root.module.ts", moduleSource("RootModule"));
      write("dist/server.js", WEBPACK_BUNDLE);

      expect(() => detect()).toThrow(
        new CliError(
          "The project is built with webpack into one server.js, which starts the application when it is loaded. Its root module is RootModule in src/root.module.ts. Run: nest-graph-inspector export --require ts-node/register",
        ),
      );
    });
  });

  describe("where nest build writes the root module", () => {
    /** main.ts booting RootModule from root.module.ts in `sourceRoot`, nothing built yet. */
    const writeSources = (sourceRoot = "src") => {
      write(`${sourceRoot}/main.ts`, ROOT_MAIN);
      write(`${sourceRoot}/root.module.ts`, moduleSource("RootModule"));
    };
    const NESTED_SWC = {
      "nest-cli.json": JSON.stringify({ sourceRoot: "apps/api/src", compilerOptions: { builder: "swc" } }),
      "tsconfig.json": DIST_TSCONFIG,
    };

    it.each<[string, Record<string, string>, string, string?]>([
      // A decoy beside it in each row is a file the build could not have written.
      [
        "beside its source when the tsconfig sets no outDir",
        { "tsconfig.json": JSON.stringify({ compilerOptions: { module: "commonjs" } }), "dist/root.module.js": "" },
        "src/root.module.js",
      ],
      [
        "under an explicit rootDir alone",
        { "tsconfig.json": JSON.stringify({ compilerOptions: { rootDir: ".", outDir: "dist" } }), "dist/root.module.js": "" },
        "dist/src/root.module.js",
      ],
      // TypeScript 6 takes the tsconfig's directory for the root directory.
      ["from the tsconfig's directory, which tsc infers", { "tsconfig.json": DIST_TSCONFIG }, "dist/src/root.module.js"],
      // TypeScript 5 took the common directory of the sources.
      ["from the sources' directory, which tsc inferred", { "tsconfig.json": DIST_TSCONFIG }, "dist/root.module.js"],
      [
        "by the tsconfig nest-cli.json names twice: tsConfigPath before the builder's configPath",
        {
          "nest-cli.json": JSON.stringify({
            compilerOptions: { tsConfigPath: "tsconfig.app.json", builder: { type: "tsc", options: { configPath: "tsconfig.builder.json" } } },
          }),
          "tsconfig.app.json": JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "build" } }),
          "tsconfig.builder.json": JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "out" } }),
        },
        "build/root.module.js",
      ],
      [
        "by SWC, in the outDir its builder's options name, over the tsconfig's",
        { "nest-cli.json": swcConfig({ outDir: "build" }), "tsconfig.json": DIST_TSCONFIG, "dist/root.module.js": "" },
        "build/root.module.js",
      ],
      [
        "by SWC, keeping the source root when the builder turns stripLeadingPaths off",
        { "nest-cli.json": swcConfig({ outDir: "build", stripLeadingPaths: false }), "tsconfig.json": DIST_TSCONFIG, "build/root.module.js": "" },
        "build/src/root.module.js",
      ],
      [
        "by SWC, with the extension the builder's options give its output",
        { "nest-cli.json": swcConfig({ outDir: "build", outFileExtension: "cjs" }), "tsconfig.json": DIST_TSCONFIG, "build/root.module.js": "" },
        "build/root.module.cjs",
      ],
      // tsc would write dist/src/root.module.js.
      [
        "by SWC, which leaves the source root out of the path",
        { "nest-cli.json": JSON.stringify({ compilerOptions: { builder: "swc" } }), "tsconfig.json": DIST_TSCONFIG },
        "dist/root.module.js",
      ],
      ["by SWC as Nest CLI 12 lays out a nested source root: whole", NESTED_SWC, "dist/apps/api/src/root.module.js", "apps/api/src"],
      ["by SWC as Nest CLI 11 lays out a nested source root: its first directory stripped", NESTED_SWC, "dist/api/src/root.module.js", "apps/api/src"],
      [
        "by SWC in the one layout the builder's stripLeadingPaths names, whatever else is there",
        {
          "nest-cli.json": swcConfig({ stripLeadingPaths: true }, { sourceRoot: "apps/api/src" }),
          "tsconfig.json": DIST_TSCONFIG,
          "dist/apps/api/src/root.module.js": "",
        },
        "dist/api/src/root.module.js",
        "apps/api/src",
      ],
    ])("finds it %s", (_case, files, compiled, sourceRoot = "src") => {
      writeSources(sourceRoot);
      writeAll(files);
      write(compiled, compiledModule("RootModule"));

      expect(detect()).toMatchObject({ origin: "main", path: at(compiled) });
    });

    it.each<[string, Record<string, string>, string, string?]>([
      [
        "from root directories tsc inferred differently",
        { "tsconfig.json": JSON.stringify({ compilerOptions: { module: "commonjs", outDir: "dist" } }), "dist/src/root.module.js": "", "dist/root.module.js": "" },
        "src/main.ts boots RootModule from src/root.module.ts, which has been built to dist/src/root.module.js and dist/root.module.js: each is where a build from a different root directory writes it, so all but one of them are left from older builds. Pass --entry with the current one, build again into an emptied outDir, or run: nest-graph-inspector export --require ts-node/register",
      ],
      [
        "by SWC as both Nest CLI 12 and 11 lay it out",
        { ...NESTED_SWC, "dist/apps/api/src/root.module.js": "", "dist/api/src/root.module.js": "" },
        "apps/api/src/main.ts boots RootModule from apps/api/src/root.module.ts, which SWC has built to both dist/apps/api/src/root.module.js and dist/api/src/root.module.js: Nest CLI 12 and Nest CLI 11 lay out its output differently, so one of them is left from an older build. Pass --entry with the current one, build again into an emptied outDir, or run: nest-graph-inspector export --require ts-node/register",
        "apps/api/src",
      ],
    ])("takes neither of two files built %s, one of them stale, unless the source is loaded instead", (_case, files, message, sourceRoot = "src") => {
      writeSources(sourceRoot);
      writeAll(files);

      expect(() => detect()).toThrow(new CliError(message));
      expect(detect({ hasLoader: true })).toMatchObject({ origin: "main", path: at(`${sourceRoot}/root.module.ts`) });
    });

    describe("by SWC for --app, when its own builder options and the top level's differ", () => {
      const files = {
        "nest-cli.json": JSON.stringify({
          sourceRoot: "src",
          compilerOptions: { builder: { type: "swc", options: { outDir: "top-build" } } },
          projects: {
            worker: {
              type: "application",
              root: "",
              sourceRoot: "src",
              compilerOptions: { builder: { type: "swc", options: { outDir: "worker-build" } } },
            },
          },
        }),
        "tsconfig.json": DIST_TSCONFIG,
        "top-build/root.module.js": compiledModule("RootModule"),
        "worker-build/root.module.js": compiledModule("RootModule"),
      };

      it.each([
        ["11.0.0", "top-build/root.module.js"],
        ["12.0.13", "top-build/root.module.js"],
        ["12.0.14-rc.0", "top-build/root.module.js"],
        ["12.0.14", "worker-build/root.module.js"],
      ])("finds it where the installed Nest CLI %s writes it", (version, compiled) => {
        writeSources();
        writeAll({ ...files, "node_modules/@nestjs/cli/package.json": JSON.stringify({ version }) });

        expect(detect({ app: "worker" })).toMatchObject({ origin: "main", path: at(compiled) });
      });

      it("reads the Nest CLI installed in a parent directory's node_modules, as Node finds it", () => {
        writeSources("app/src");
        writeAll(Object.fromEntries(Object.entries(files).map(([path, content]) => [`app/${path}`, content])));
        write("node_modules/@nestjs/cli/package.json", JSON.stringify({ version: "12.0.14" }));

        expect(detect({ app: "worker", projectDir: at("app"), cwd: at("app") })).toMatchObject({
          origin: "main",
          path: at("app/worker-build/root.module.js"),
        });
      });

      it.each<[string, string | undefined]>([
        ["none is installed", undefined],
        ["its package.json does not parse", "{"],
        ["its package.json has no version", JSON.stringify({ name: "@nestjs/cli" })],
        ["its version is not a string", JSON.stringify({ version: ["12.0.14"] })],
      ])("takes neither when no installed Nest CLI's version can be read: %s", (_case, manifest) => {
        writeSources();
        writeAll(manifest === undefined ? files : { ...files, "node_modules/@nestjs/cli/package.json": manifest });

        expect(() => detect({ app: "worker" })).toThrow(
          new CliError(
            "src/main.ts boots RootModule from src/root.module.ts, which SWC has built to both worker-build/root.module.js and top-build/root.module.js: Nest CLI 12 and Nest CLI 11 lay out its output differently, so one of them is left from an older build. Pass --entry with the current one, build again into an emptied outDir, or run: nest-graph-inspector export --require ts-node/register",
          ),
        );
      });
    });

    it.each<[string, Record<string, string>, string, string[]?]>([
      [
        "names the command that loads its TypeScript source",
        { "tsconfig.json": STANDARD_TSCONFIG },
        "which has not been built to dist/root.module.js. Build your project first (nest build), or run: nest-graph-inspector export --require ts-node/register",
      ],
      [
        "names the tsconfig the application builds with in that command, when it is not tsconfig.json",
        {
          "tsconfig.json": STANDARD_TSCONFIG,
          "tsconfig build.json": STANDARD_TSCONFIG,
          "nest-cli.json": JSON.stringify({ compilerOptions: { tsConfigPath: "tsconfig build.json" } }),
        },
        "which has not been built to dist/root.module.js. Build your project first (nest build), or run: TS_NODE_PROJECT='tsconfig build.json' nest-graph-inspector export --out 'graph output.json' --require ts-node/register",
        ["export", "--out", "graph output.json"],
      ],
      [
        "looks only under an explicit rootDir, never at a stale file elsewhere",
        // From a build before rootDir was set: not what tsc writes now.
        { "tsconfig.json": JSON.stringify({ compilerOptions: { rootDir: ".", outDir: "dist" } }), "dist/root.module.js": "" },
        "which has not been built to dist/src/root.module.js. Build your project first (nest build), or run: nest-graph-inspector export --require ts-node/register",
      ],
      [
        "says it was not built to the outDir SWC's builder options name",
        { "nest-cli.json": swcConfig({ outDir: "build" }), "tsconfig.json": DIST_TSCONFIG },
        "which has not been built to build/root.module.js. Build your project first (nest build), or run: nest-graph-inspector export --require ts-node/register",
      ],
    ])("when it is not built, %s", (_case, files, message, argv = ["export"]) => {
      writeSources();
      writeAll(files);

      expect(() => detect({ argv })).toThrow(
        new CliError(`No compiled RootModule found: src/main.ts boots it from src/root.module.ts, ${message}`),
      );
    });

    it.each([
      ["the TypeScript source while nothing is built", false, "src/root.module.ts"],
      ["the compiled file once there is one", true, "dist/root.module.js"],
    ])("given a --require loader, loads %s", (_case, built, path) => {
      write("tsconfig.json", STANDARD_TSCONFIG);
      writeSources();
      if (built) {
        write("dist/root.module.js", compiledModule("RootModule"));
      }

      expect(detect({ hasLoader: true })).toMatchObject({ origin: "main", path: at(path), moduleName: "RootModule" });
    });

    it.each<[string, Record<string, string>, string]>([
      ["when the tsconfig sets no outDir", { "tsconfig.json": JSON.stringify({ compilerOptions: { module: "commonjs" } }), "dist/app.module.js": "" }, "dist/app.module.js"],
      [
        "when tsc could have written it to two places",
        { "tsconfig.json": DIST_TSCONFIG, "dist/app.module.js": "", "dist/src/app.module.js": "" },
        "dist/app.module.js",
      ],
      [
        "from the tsconfig it always has read: the builder's configPath first",
        {
          "nest-cli.json": JSON.stringify({
            compilerOptions: { tsConfigPath: "tsconfig.app.json", builder: { type: "tsc", options: { configPath: "tsconfig.builder.json" } } },
          }),
          "tsconfig.app.json": JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "build" } }),
          "tsconfig.builder.json": JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "out" } }),
          "build/app.module.js": "",
          "out/app.module.js": "",
        },
        "out/app.module.js",
      ],
    ])("still finds app.module.js by convention, as it always has, %s", (_case, files, entry) => {
      writeSources();
      writeAll(files);

      expect(detect()).toMatchObject({ origin: "convention", path: at(entry) });
    });
  });

  describe("files that start the application", () => {
    it.each<[string, Record<string, string>, string, string, Partial<EntryRequest>?]>([
      ["main.js compiled by tsc", { "dist/main.js": COMPILED_MAIN }, "dist/main.js", "it calls NestFactory.create"],
      ["a webpack bundle, whatever its name", { "dist/server-bundle.js": WEBPACK_BUNDLE }, "dist/server-bundle.js", "it calls NestFactory.create"],
      [
        "the application's compiled entry file, even when it calls NestFactory elsewhere",
        { "dist/main.js": BOOTSTRAPPING_MAIN, "src/main.ts": 'import { bootstrap } from "./bootstrap";\nvoid bootstrap();\n' },
        "dist/main.js",
        ENTRY_FILE,
      ],
      [
        "the application's entry file as source, given a loader",
        { "src/main.ts": 'import { bootstrap } from "./bootstrap";\nvoid bootstrap();\n' },
        "src/main.ts",
        ENTRY_FILE,
        { hasLoader: true },
      ],
      [
        "the entry file SWC writes to the outDir its builder's options name",
        { "nest-cli.json": swcConfig({ outDir: "build" }), "build/main.js": BOOTSTRAPPING_MAIN },
        "build/main.js",
        ENTRY_FILE,
      ],
      [
        "the entry file SWC writes with the extension its builder's options name",
        { "nest-cli.json": swcConfig({ outDir: "build", outFileExtension: "cjs" }), "build/main.cjs": BOOTSTRAPPING_MAIN },
        "build/main.cjs",
        ENTRY_FILE,
      ],
    ])("refuses --entry at %s", (_case, files, entry, reason, request = {}) => {
      writeAll(files);

      expect(() => detect({ entry, ...request })).toThrow(new CliError(startsTheApplication(entry, reason)));
    });

    it("loads --entry at a module file", () => {
      const entry = write("dist/app.module.js", compiledModule("AppModule"));

      expect(detect({ entry: "dist/app.module.js" })).toEqual({ origin: "entry", path: entry, moduleName: undefined, notes: [], warnings: [] });
    });

    describe("paths that name the entry file another way", () => {
      beforeEach(() => {
        write("tsconfig.json", STANDARD_TSCONFIG);
        write("src/main.ts", 'import { bootstrap } from "./bootstrap";\nvoid bootstrap();\n');
      });

      it("refuses a symlink to the entry file, and one through a symlinked directory", () => {
        const main = write("dist/main.js", BOOTSTRAPPING_MAIN);
        symlinkSync(main, at("dist/server.js"));
        symlinkSync(at("dist"), at("linked"));

        for (const entry of ["dist/server.js", "linked/main.js"]) {
          expect(() => detect({ entry })).toThrow(new CliError(startsTheApplication(entry, ENTRY_FILE)));
        }
      });

      it("refuses the entry file through a symlinked outDir", () => {
        // `nest build` writes through the link; --entry names the real file.
        const main = write("build/main.js", BOOTSTRAPPING_MAIN);
        symlinkSync(at("build"), at("dist"));

        expect(() => detect({ entry: "build/main.js" })).toThrow(
          new CliError(startsTheApplication("build/main.js", ENTRY_FILE)),
        );
        expect(realpathSync(at("dist/main.js"))).toBe(main);
      });

      it("loads the file it checked: a symlink's target", () => {
        const module = write("dist/app.module.js", compiledModule("AppModule"));
        symlinkSync(module, at("dist/root.js"));

        expect(detect({ entry: "dist/root.js" })).toEqual({ origin: "entry", path: module, moduleName: undefined, notes: [], warnings: [] });
      });
    });

    describe("an entry file in a directory of its own", () => {
      beforeEach(() => {
        write("tsconfig.json", STANDARD_TSCONFIG);
        write("src/admin/server.ts", mainSource('import { ServerModule } from "../server";', "NestFactory.create(ServerModule)"));
        write("src/server.ts", moduleSource("ServerModule"));
        write("dist/admin/server.js", COMPILED_MAIN);
      });

      it("loads, from a tsc build, the module file where a bundle would be named", () => {
        write("nest-cli.json", JSON.stringify({ entryFile: "admin/server" }));
        const module = write("dist/server.js", compiledModule("ServerModule"));

        expect(detect()).toMatchObject({ origin: "main", path: module, moduleName: "ServerModule" });
        expect(detect({ entry: "dist/server.js" })).toEqual({ origin: "entry", path: module, moduleName: undefined, notes: [], warnings: [] });
      });

      it("refuses that path in a bundled build, whose one file it is", () => {
        write("nest-cli.json", JSON.stringify({ entryFile: "admin/server", compilerOptions: { builder: "webpack" } }));
        write("dist/server.js", compiledModule("ServerModule"));

        expect(() => detect({ entry: "dist/server.js" })).toThrow(
          new CliError(startsTheApplication("dist/server.js", ENTRY_FILE)),
        );
      });
    });

    it("refuses an app.module.js found by convention that starts the application", () => {
      write("dist/app.module.js", `${compiledModule("AppModule")}require("@nestjs/core").NestFactory.create(AppModule);\n`);

      expect(() => detect()).toThrow(
        new CliError(startsTheApplication("dist/app.module.js", "it calls NestFactory.create")),
      );
    });
  });

  describe(findNestFactoryCall.name, () => {
    const call = (text: string, fileName = "file.js") =>
      findNestFactoryCall(ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS));

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
      ["const { createMicroservice: boot } = NestFactory;\nboot(AppModule, {});", "NestFactory.createMicroservice"],
      ["const create = core_1.NestFactory.create;\ncreate.call(core_1.NestFactory, AppModule);", "NestFactory.create"],
      ["const create = NestFactory.create.bind(NestFactory);\ncreate(AppModule);", "NestFactory.create"],
      ["let F;\nF = NestFactory;\nF.createApplicationContext(AppModule);", "NestFactory.createApplicationContext"],
      ["let create;\ncreate = core_1.NestFactory.create;\ncreate(AppModule);", "NestFactory.create"],
      ["const get = () => { const B = A; return B.create(AppModule); };\nconst A = NestFactory;\nget();", "NestFactory.create"],
      ["const boot = () => C.createMicroservice(AppModule, {});\nconst C = B;\nconst B = A;\nconst A = core_1.NestFactory;\nboot();", "NestFactory.createMicroservice"],
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
