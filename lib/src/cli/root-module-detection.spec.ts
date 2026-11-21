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
import {
  detectEntry,
  resolveEntry,
  selectEntryModule,
  type EntryRequest,
} from "./project";
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

/** A module file that default-exports its one module. */
function defaultModuleSource(name: string): string {
  return `import { Module } from "@nestjs/common";\n\n@Module({})\nexport default class ${name} {}\n`;
}

/** The same, as tsc compiles it to CommonJS. */
function compiledDefaultModule(name: string): string {
  return `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
let ${name} = class ${name} {};
${name} = __decorate([(0, common_1.Module)({})], ${name});
exports.default = ${name};
`;
}

/**
 * The exports a compiled fixture defines — each `exports.<name> =` — as the
 * Nest modules they are: its export shape, read rather than loaded.
 */
function exportsOf(path: string): Record<string, unknown> {
  return Object.fromEntries(
    [...readFileSync(path, "utf8").matchAll(/^exports\.(\w+) = /gm)].map(([, name]) => {
      const module = class {};
      Module({ imports: [] })(module);
      return [name, module];
    }),
  );
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

  /**
   * A built project whose main.ts boots `RootModule` from root.module.ts,
   * which exports it under `exportName`: by its name, or as its default.
   */
  const writeRootModuleProject = (
    main = mainSource(
      'import { RootModule } from "./root.module";',
      "NestFactory.create(RootModule)",
    ),
    exportName: "RootModule" | "default" = "RootModule",
  ) => {
    const byDefault = exportName === "default";
    write("tsconfig.json", STANDARD_TSCONFIG);
    write("src/main.ts", main);
    write(
      "src/root.module.ts",
      byDefault ? defaultModuleSource("RootModule") : moduleSource("RootModule"),
    );
    write("dist/main.js", COMPILED_MAIN);
    return write(
      "dist/root.module.js",
      byDefault ? compiledDefaultModule("RootModule") : compiledModule("RootModule"),
    );
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
    ] as const)("follows %s", (_form, imports, boot, moduleName) => {
      const compiled = writeRootModuleProject(mainSource(imports, boot), moduleName);

      const resolved = detect();
      expect(resolved).toMatchObject({ origin: "main", path: compiled, moduleName });
      // A name the compiled file does export, so the export takes it.
      expect(
        selectEntryModule(exportsOf(compiled), resolved.moduleName, compiled, projectDir).name,
      ).toBe(moduleName);
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

    describe("an .mts main.ts under NodeNext, an ES module of a CommonJS package", () => {
      beforeEach(() => {
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
        write("src/root.module.ts", moduleSource("RootModule"));
      });
      const bootingFrom = (imports: string, root: string) =>
        `import { NestFactory } from "@nestjs/core";\n${imports}\n\nvoid NestFactory.create(${root}).then((app) => app.listen(3000));\n`;

      it("resolves import = require() as require does, in CommonJS mode, without an extension", () => {
        write(
          "src/main.mts",
          bootingFrom('import modules = require("./root.module");', "modules.RootModule"),
        );
        const compiled = write("dist/root.module.js", compiledModule("RootModule"));

        expect(detect()).toMatchObject({
          origin: "main",
          path: compiled,
          moduleName: "RootModule",
          mainFile: at("src/main.mts"),
        });
      });

      it("resolves an import in the file's own ESM mode, where a relative path needs its extension", () => {
        write("dist/root.module.js", compiledModule("RootModule"));
        write("dist/main.mjs", COMPILED_MAIN);
        write("src/main.mts", bootingFrom('import { RootModule } from "./root.module";', "RootModule"));

        expect(() => detect()).toThrow(conventionError());

        write("src/main.mts", bootingFrom('import { RootModule } from "./root.module.js";', "RootModule"));
        expect(detect()).toMatchObject({ origin: "main", path: at("dist/root.module.js") });
      });
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
      [
        "NestFactory destructured from require()",
        `const { NestFactory } = require("@nestjs/core");
const { RootModule } = require("./root.module");

void NestFactory.create(RootModule).then((app) => app.listen(3000));
`,
      ],
      [
        "import core = require()",
        `import core = require("@nestjs/core");
import { RootModule } from "./root.module";

void core.NestFactory.create(RootModule).then((app) => app.listen(3000));
`,
      ],
      [
        "an alias of NestFactory, which keeps its receiver",
        `import { NestFactory } from "@nestjs/core";
import { RootModule } from "./root.module";

const Factory = NestFactory;
void Factory.create(RootModule).then((app) => app.listen(3000));
`,
      ],
      [
        "a let alias of NestFactory nothing assigns again",
        `import { NestFactory } from "@nestjs/core";
import { RootModule } from "./root.module";

let Factory = NestFactory;
void Factory.create(RootModule).then((app) => app.listen(3000));
`,
      ],
      [
        "a dynamic import()",
        `import { RootModule } from "./root.module";

async function bootstrap() {
  const { NestFactory } = await import("@nestjs/core");
  const app = await NestFactory.create(RootModule);
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

    describe("two root modules of one name", () => {
      beforeEach(() => {
        write("tsconfig.json", STANDARD_TSCONFIG);
        write(
          "src/main.ts",
          `import { NestFactory } from "@nestjs/core";
import { RootModule as Api } from "./api/root.module";
import { RootModule as Worker } from "./worker/root.module";

async function bootstrap() {
  const api = await NestFactory.create(Api);
  const worker = await NestFactory.createApplicationContext(Worker);
  await Promise.all([api.listen(3000), worker.init()]);
}
void bootstrap();
`,
        );
        for (const app of ["api", "worker"]) {
          write(`src/${app}/root.module.ts`, moduleSource("RootModule"));
          write(`dist/${app}/root.module.js`, compiledModule("RootModule"));
        }
      });
      const both =
        "RootModule from src/api/root.module.ts, RootModule from src/worker/root.module.ts";

      it("refuses a --module that names both, rather than take the first", () => {
        expect(() => detect({ module: "RootModule" })).toThrow(
          new CliError(
            `src/main.ts boots 2 root modules named RootModule (${both}). Pass --entry <file> and --module RootModule for the one to export.`,
          ),
        );
      });

      it("takes the one a --module naming its import alias picks", () => {
        expect(detect({ module: "Worker" })).toMatchObject({
          origin: "main",
          path: at("dist/worker/root.module.js"),
          moduleName: "RootModule",
        });
      });

      it("asks for --entry and --module without one", () => {
        expect(() => detect()).toThrow(
          new CliError(
            `src/main.ts boots 2 root modules (${both}). Pass --entry <file> and --module <name>.`,
          ),
        );
      });
    });

    describe("the root module a name holds, in its own scope", () => {
      /** main.ts importing ApiModule and WorkerModule, with `declarations` at its top and `local` in bootstrap(). */
      const bootingWith = (declarations: string, local: string, argument: string) => `import { NestFactory } from "@nestjs/core";
import { ApiModule as RootModule } from "./api.module";
import { WorkerModule } from "./worker.module";
${declarations}

async function bootstrap() {
${local}
  const app = await NestFactory.create(${argument});
  await app.listen(3000);
}
void bootstrap();
`;

      beforeEach(() => {
        write("tsconfig.json", STANDARD_TSCONFIG);
        write("src/api.module.ts", moduleSource("ApiModule"));
        write("src/worker.module.ts", moduleSource("WorkerModule"));
        write("dist/api.module.js", compiledModule("ApiModule"));
        write("dist/worker.module.js", compiledModule("WorkerModule"));
      });

      it.each([
        ["a const that shadows an import", "", "  const RootModule = WorkerModule;", "RootModule"],
        ["a let nothing assigns again", "let root = WorkerModule;", "", "root"],
      ])("follows %s to the module it holds", (_case, declarations, local, argument) => {
        write("src/main.ts", bootingWith(declarations, local, argument));

        expect(detect()).toMatchObject({
          origin: "main",
          path: at("dist/worker.module.js"),
          moduleName: "WorkerModule",
        });
      });

      it.each([
        ["a let assigned again", "let root = RootModule;\nroot = WorkerModule;"],
        ["a var declared twice", "var root = RootModule;\nvar root = WorkerModule;"],
      ])("follows no root module through %s", (_case, declarations) => {
        write("src/main.ts", bootingWith(declarations, "", "root"));

        expect(() => detect()).toThrow(conventionError());
      });
    });

    describe("root modules main.ts names through a const of its own", () => {
      beforeEach(() => {
        write("tsconfig.json", STANDARD_TSCONFIG);
        write(
          "src/main.ts",
          `import { NestFactory } from "@nestjs/core";
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
`,
        );
        write("src/api.module.ts", moduleSource("ApiModule"));
        write("src/worker.module.ts", moduleSource("WorkerModule"));
        write("dist/api.module.js", compiledModule("ApiModule"));
        write("dist/worker.module.js", compiledModule("WorkerModule"));
      });

      it.each(["Worker", "WorkerModule"])("takes the one --module %s names: the const's name, or the class's", (module) => {
        expect(detect({ module })).toMatchObject({
          origin: "main",
          path: at("dist/worker.module.js"),
          moduleName: "WorkerModule",
        });
      });

      it("lists them by the names their files export them under", () => {
        expect(() => detect()).toThrow(
          new CliError(
            "src/main.ts boots 2 root modules (ApiModule, WorkerModule). Pass --module <name>.",
          ),
        );
      });
    });

    it("names the class, not the const, in the warning for a const that holds its forRoot()", () => {
      const compiled = writeRootModuleProject(
        mainSource(
          'import { RootModule } from "./root.module";\n\nconst Root = RootModule.forRoot({ url: process.env.DATABASE_URL });',
          "NestFactory.create(Root)",
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

    it("counts a method destructured from NestFactory by its syntax alone", () => {
      // A heuristic over the syntax, not a claim that the call boots: Nest's
      // create() reads `this`, so called without its receiver it throws.
      const compiled = writeRootModuleProject(`import { NestFactory } from "@nestjs/core";
import { RootModule } from "./root.module";

const { create } = NestFactory;
void create(RootModule);
`);

      expect(detect()).toMatchObject({
        origin: "main",
        path: compiled,
        moduleName: "RootModule",
      });
    });

    describe("a NestFactory that is not @nestjs/core's", () => {
      it("counts only the boot through @nestjs/core's, so one root module is no choice", () => {
        const compiled = writeRootModuleProject(`import { NestFactory } from "@nestjs/core";
import { RootModule } from "./root.module";
import { HelperModule } from "./helper.module";
import { tools } from "./tools";

async function bootstrap() {
  tools.NestFactory.create(HelperModule);
  const app = await NestFactory.create(RootModule);
  await app.listen(3000);
}
void bootstrap();
`);
        write("src/helper.module.ts", moduleSource("HelperModule"));
        write("dist/helper.module.js", compiledModule("HelperModule"));

        expect(detect()).toMatchObject({
          origin: "main",
          path: compiled,
          moduleName: "RootModule",
        });
      });

      it.each([
        [
          "an import from elsewhere",
          'import { NestFactory } from "./testing";\nimport { RootModule } from "./root.module";\n\nvoid NestFactory.create(RootModule);\n',
        ],
        [
          "an object of its own",
          'import { RootModule } from "./root.module";\n\nconst factories = { NestFactory: { create: (module: unknown) => module } };\nfactories.NestFactory.create(RootModule);\n',
        ],
        [
          "a parameter that shadows the import",
          'import { NestFactory } from "@nestjs/core";\nimport { RootModule } from "./root.module";\n\nexport function boot(NestFactory: { create(module: unknown): unknown }) {\n  return NestFactory.create(RootModule);\n}\n',
        ],
      ])("boots nothing through %s", (_case, main) => {
        write("tsconfig.json", STANDARD_TSCONFIG);
        write("src/main.ts", main);
        write("src/root.module.ts", moduleSource("RootModule"));
        write("dist/root.module.js", compiledModule("RootModule"));

        expect(() => detect()).toThrow(conventionError());
      });

      /** A main.ts that boots RootModule through `boot`, after `helper` calls create() on something else. */
      const shadowing = (imports: string, helper: string, boot: string) => `${imports}
import { HelperModule } from "./helper.module";
import { RootModule } from "./root.module";

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
          "a function's parameter",
          shadowing(
            'import * as core from "@nestjs/core";',
            "export function warmUp(core: typeof fakes) {\n  core.NestFactory.create(HelperModule);\n}",
            "core.NestFactory.create(RootModule)",
          ),
        ],
        [
          "an arrow function's parameter",
          shadowing(
            'import { NestFactory } from "@nestjs/core";',
            "export const warmUp = (NestFactory: Factory) => NestFactory.create(HelperModule);",
            "NestFactory.create(RootModule)",
          ),
        ],
        [
          "a catch clause's variable",
          shadowing(
            'import { NestFactory } from "@nestjs/core";',
            "try {\n  JSON.parse(\"\");\n} catch (NestFactory) {\n  (NestFactory as Factory).create(HelperModule);\n}",
            "NestFactory.create(RootModule)",
          ),
        ],
        [
          "a block's const",
          shadowing(
            'import { NestFactory as F } from "@nestjs/core";',
            "{\n  const F = fakes.NestFactory;\n  F.create(HelperModule);\n}",
            "F.create(RootModule)",
          ),
        ],
        [
          "a function's var, declared after its use",
          shadowing(
            'import * as core from "@nestjs/core";',
            "export function warmUp() {\n  core.NestFactory.create(HelperModule);\n  var core = fakes;\n}",
            "core.NestFactory.create(RootModule)",
          ),
        ],
      ])("counts no call through %s that shadows the import, and still the import's own", (_scope, main) => {
        const compiled = writeRootModuleProject(main);
        write("src/helper.module.ts", moduleSource("HelperModule"));
        write("dist/helper.module.js", compiledModule("HelperModule"));

        expect(detect()).toMatchObject({
          origin: "main",
          path: compiled,
          moduleName: "RootModule",
        });
      });

      it.each([
        [
          "a let alias of NestFactory assigned something else",
          shadowing(
            'import { NestFactory } from "@nestjs/core";',
            "let Factory = NestFactory;\nFactory = fakes.NestFactory as typeof NestFactory;\nvoid Factory.create(HelperModule);",
            "NestFactory.create(RootModule)",
          ),
        ],
        [
          "a parameter named require",
          shadowing(
            'import { NestFactory } from "@nestjs/core";',
            'export function warmUp(require: (id: string) => typeof fakes) {\n  require("@nestjs/core").NestFactory.create(HelperModule);\n}',
            "NestFactory.create(RootModule)",
          ),
        ],
      ])("counts no call through %s, and still the import's own", (_case, main) => {
        const compiled = writeRootModuleProject(main);
        write("src/helper.module.ts", moduleSource("HelperModule"));
        write("dist/helper.module.js", compiledModule("HelperModule"));

        expect(detect()).toMatchObject({
          origin: "main",
          path: compiled,
          moduleName: "RootModule",
        });
      });
    });

    it("says which boots it passed over, by line, when another decides", () => {
      const compiled = writeRootModuleProject(`import { NestFactory } from "@nestjs/core";
import { HostModule } from "@acme/host";
import { RootModule } from "./root.module";
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

      // ts-node and tsconfig-paths read tsconfig.json unless TS_NODE_PROJECT
      // names the one the application builds with.
      expect(() => detect({ app: "api", argv: ["export", "--app", "api"] })).toThrow(
        new CliError(
          "apps/api is built with webpack into one main.js, which starts the application when it is loaded. Its root module is ApiModule in apps/api/src/api.module.ts. Run: TS_NODE_PROJECT=apps/api/tsconfig.app.json nest-graph-inspector export --app api --require ts-node/register --require tsconfig-paths/register",
        ),
      );
      expect(detect({ app: "api", hasLoader: true })).toMatchObject({
        origin: "main",
        path: at("apps/api/src/api.module.ts"),
        moduleName: "ApiModule",
      });
    });

    it("builds a monorepo that names no builder with tsc, as the Nest CLI does", () => {
      writeMonorepo({
        monorepo: true,
        root: "apps/api",
        sourceRoot: "apps/api/src",
        compilerOptions: { tsConfigPath: "apps/api/tsconfig.app.json" },
      });
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
      expect(detect({ app: "worker" })).toMatchObject({
        origin: "main",
        path: at("dist/apps/worker/apps/worker/src/worker.module.js"),
        moduleName: "WorkerModule",
      });
    });

    it('treats the "builder": "rspack" nest g app writes as a bundle', () => {
      writeMonorepo({
        monorepo: true,
        root: "apps/api",
        sourceRoot: "apps/api/src",
        compilerOptions: { builder: "rspack", tsConfigPath: "apps/api/tsconfig.app.json" },
      });
      write("dist/apps/api/main.js", WEBPACK_BUNDLE);

      expect(() => detect()).toThrow(
        new CliError(
          "apps/api is built with rspack into one main.js, which starts the application when it is loaded. Its root module is ApiModule in apps/api/src/api.module.ts. Run: TS_NODE_PROJECT=apps/api/tsconfig.app.json nest-graph-inspector export --require ts-node/register --require tsconfig-paths/register",
        ),
      );
    });

    it("takes webpack: true from the top level, unless --app's project sets its own", () => {
      const topLevel = {
        ...TSC_TOP_LEVEL,
        compilerOptions: { ...TSC_TOP_LEVEL.compilerOptions, webpack: true },
      };
      writeMonorepo(topLevel);
      writeTscBuild();
      // `webpack` wins over the builder; worker turns it off for itself.
      write(
        "nest-cli.json",
        JSON.stringify({
          ...topLevel,
          projects: {
            ...projects,
            worker: {
              ...projects.worker,
              compilerOptions: { ...projects.worker.compilerOptions, webpack: false },
            },
          },
        }),
      );

      expect(() => detect({ app: "api", argv: ["export", "--app", "api"] })).toThrow(
        new CliError(
          "apps/api is built with webpack into one main.js, which starts the application when it is loaded. Its root module is ApiModule in apps/api/src/api.module.ts. Run: TS_NODE_PROJECT=apps/api/tsconfig.app.json nest-graph-inspector export --app api --require ts-node/register --require tsconfig-paths/register",
        ),
      );
      expect(detect({ app: "worker" })).toMatchObject({
        origin: "main",
        path: at("dist/apps/worker/apps/worker/src/worker.module.js"),
        moduleName: "WorkerModule",
      });
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
            api: {
              ...projects.api,
              entryFile: "server",
              compilerOptions: { ...projects.api.compilerOptions, builder: "webpack" },
            },
          },
        }),
      );
      write(
        "apps/api/src/server.ts",
        mainSource('import { ApiModule } from "./api.module";', "NestFactory.create(ApiModule)"),
      );

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
      expect(() => detect({ app: "api", argv: ["export", "--app", "api"] })).toThrow(
        new CliError(
          "apps/api is built with webpack into one server.js, which starts the application when it is loaded. Its root module is ApiModule in apps/api/src/api.module.ts. Run: TS_NODE_PROJECT=apps/api/tsconfig.app.json nest-graph-inspector export --app api --require ts-node/register --require tsconfig-paths/register",
        ),
      );
    });

    describe("an entry found by convention", () => {
      it("says which application it is, without --app", () => {
        writeMonorepo(TSC_TOP_LEVEL);
        const entry = write(
          "dist/apps/api/apps/api/src/app.module.js",
          compiledModule("AppModule"),
        );

        expect(detect()).toMatchObject({ origin: "convention", path: entry, notes: [NOTE] });
        expect(detect({ app: "api" })).toMatchObject({
          origin: "convention",
          path: entry,
          notes: [],
        });
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
        write(
          "tsconfig.json",
          JSON.stringify({ compilerOptions: { module: "commonjs", rootDir: ".", outDir: "dist" } }),
        );
        write(
          "apps/api/src/main.ts",
          mainSource('import { AppModule } from "./app.module";', "NestFactory.create(AppModule)"),
        );
        write("apps/api/src/app.module.ts", moduleSource("AppModule"));
        write(
          "apps/worker/src/main.ts",
          mainSource(
            'import { WorkerModule } from "./worker.module";',
            "NestFactory.create(WorkerModule)",
          ),
        );
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
          notes: [
            "entry dist/apps/worker/src/worker.module.js (WorkerModule, from apps/worker/src/main.ts)",
          ],
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

        expect(detect()).toMatchObject({
          origin: "convention",
          path: entry,
          notes: [NOTE],
        });

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
          JSON.stringify({
            extends: "../../tsconfig.json",
            compilerOptions: { rootDir: "..", outDir: "../../dist/worker" },
          }),
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
        const application = (app: string) => ({
          type: "application",
          root: `apps/${app}`,
          sourceRoot: `apps/${app}/src`,
        });
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
          write(
            `apps/${app}/src/main.ts`,
            mainSource('import { RootModule } from "./root.module";', "NestFactory.create(RootModule)"),
          );
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
          JSON.stringify({
            extends: "../../tsconfig.json",
            compilerOptions: compilerOptions[app],
            include: ["src/**/*"],
          }),
        );
      }
    };

    describe("applications whose builds take different root directories", () => {
      // api's rootDir is apps/api, worker's apps/worker/src, and both write to
      // dist/: api's src/root.module.ts and worker's src/src/root.module.ts
      // both become dist/src/root.module.js.
      beforeEach(() => {
        writeOwnTsConfigs({
          api: { rootDir: ".", outDir: "../../dist" },
          worker: { rootDir: "src", outDir: "../../dist" },
        });
        write(
          "apps/api/src/main.ts",
          mainSource('import { RootModule } from "./root.module";', "NestFactory.create(RootModule)"),
        );
        write("apps/api/src/root.module.ts", moduleSource("RootModule"));
        write(
          "apps/worker/src/main.ts",
          mainSource('import { RootModule } from "./src/root.module";', "NestFactory.create(RootModule)"),
        );
        write("apps/worker/src/src/root.module.ts", moduleSource("RootModule"));
        // Only api has been built.
        write("dist/src/root.module.js", compiledModule("RootModule"));
      });

      it("will not take, for --app, a file the other's build writes from a source at another path", () => {
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
    });

    it("takes a file a bundled application's build could not have written, though it has a source at that path", () => {
      // api built by tsc into dist/, worker by webpack into one main.js: only
      // tsc writes a dist/root.module.js.
      writeOwnTsConfigs(
        {
          api: { rootDir: "src", outDir: "../../dist" },
          worker: { rootDir: "src", outDir: "../../dist" },
        },
        { worker: "webpack" },
      );
      for (const app of ["api", "worker"]) {
        write(
          `apps/${app}/src/main.ts`,
          mainSource('import { RootModule } from "./root.module";', "NestFactory.create(RootModule)"),
        );
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
        const worker = {
          type: "application",
          root: "",
          sourceRoot: "src",
          compilerOptions: { builder: "swc", tsConfigPath: "tsconfig.json" },
        };
        write(
          "nest-cli.json",
          JSON.stringify({
            monorepo: true,
            root: "",
            sourceRoot: "src",
            compilerOptions: { builder: "swc", tsConfigPath: "tsconfig.json" },
            projects: {
              worker,
              api: {
                type: "application",
                root: "apps/api",
                sourceRoot: "apps/api/src",
                compilerOptions: { builder: "tsc", tsConfigPath: "apps/api/tsconfig.app.json" },
              },
            },
          }),
        );
        write(
          "tsconfig.json",
          JSON.stringify({ compilerOptions: { module: "commonjs", rootDir: ".", outDir: "dist" } }),
        );
        write(
          "apps/api/tsconfig.app.json",
          JSON.stringify({ extends: "../../tsconfig.json", compilerOptions: { rootDir: "src" } }),
        );
        write(
          "src/main.ts",
          mainSource('import { WorkerModule } from "./worker.module";', "NestFactory.create(WorkerModule)"),
        );
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
        expect(detect({ app: "worker" })).toMatchObject({
          origin: "main",
          path: at("dist/worker.module.js"),
        });

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

    it("names the bundle after the entry file", () => {
      write("nest-cli.json", JSON.stringify({ entryFile: "server", compilerOptions: { builder: "webpack" } }));
      write("tsconfig.json", STANDARD_TSCONFIG);
      write(
        "src/server.ts",
        mainSource('import { RootModule } from "./root.module";', "NestFactory.create(RootModule)"),
      );
      write("src/root.module.ts", moduleSource("RootModule"));
      write("dist/server.js", WEBPACK_BUNDLE);

      expect(() => detect()).toThrow(
        new CliError(
          "The project is built with webpack into one server.js, which starts the application when it is loaded. Its root module is RootModule in src/root.module.ts. Run: nest-graph-inspector export --require ts-node/register",
        ),
      );
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
          "No compiled RootModule found: src/main.ts boots it from src/root.module.ts, which has not been built to dist/root.module.js. Build your project first (nest build), or run: nest-graph-inspector export --require ts-node/register",
        ),
      );
    });

    it("names the tsconfig the application builds with in that command, when it is not tsconfig.json", () => {
      write("tsconfig build.json", STANDARD_TSCONFIG);
      write(
        "nest-cli.json",
        JSON.stringify({ compilerOptions: { tsConfigPath: "tsconfig build.json" } }),
      );

      expect(() => detect({ argv: ["export", "--out", "graph output.json"] })).toThrow(
        new CliError(
          "No compiled RootModule found: src/main.ts boots it from src/root.module.ts, which has not been built to dist/root.module.js. Build your project first (nest build), or run: TS_NODE_PROJECT='tsconfig build.json' nest-graph-inspector export --out 'graph output.json' --require ts-node/register",
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

  describe("where tsc writes the root module", () => {
    beforeEach(() => {
      write(
        "src/main.ts",
        mainSource('import { RootModule } from "./root.module";', "NestFactory.create(RootModule)"),
      );
      write("src/root.module.ts", moduleSource("RootModule"));
    });

    it("finds it beside its source when the tsconfig sets no outDir", () => {
      write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs" } }));
      // Not tsc's output: a file it could not have written.
      write("dist/root.module.js", compiledModule("RootModule"));
      const compiled = write("src/root.module.js", compiledModule("RootModule"));

      expect(detect()).toMatchObject({ origin: "main", path: compiled });
    });

    it("still finds app.module.js under dist by convention when the tsconfig sets no outDir", () => {
      write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs" } }));
      const entry = write("dist/app.module.js", compiledModule("AppModule"));

      expect(detect()).toMatchObject({ origin: "convention", path: entry });
    });

    it("looks only under an explicit rootDir, never at a stale file elsewhere", () => {
      write(
        "tsconfig.json",
        JSON.stringify({ compilerOptions: { rootDir: ".", outDir: "dist" } }),
      );
      // From a build before rootDir was set: not what tsc writes now.
      write("dist/root.module.js", compiledModule("RootModule"));

      expect(() => detect()).toThrow(
        new CliError(
          "No compiled RootModule found: src/main.ts boots it from src/root.module.ts, which has not been built to dist/src/root.module.js. Build your project first (nest build), or run: nest-graph-inspector export --require ts-node/register",
        ),
      );

      const compiled = write("dist/src/root.module.js", compiledModule("RootModule"));
      expect(detect()).toMatchObject({ origin: "main", path: compiled });
    });

    describe("a tsconfig with an outDir and no rootDir, whose root directory tsc infers", () => {
      beforeEach(() => {
        write("tsconfig.json", JSON.stringify({ compilerOptions: { module: "commonjs", outDir: "dist" } }));
      });

      it.each([
        // TypeScript 6 takes the tsconfig's directory.
        ["the tsconfig's directory", "dist/src/root.module.js"],
        // TypeScript 5 took the common directory of the sources.
        ["the sources' directory", "dist/root.module.js"],
      ])("takes the one file there is, built from %s", (_root, path) => {
        const compiled = write(path, compiledModule("RootModule"));

        expect(detect()).toMatchObject({ origin: "main", path: compiled });
      });

      it("takes neither of two, one left from a build that inferred another root directory", () => {
        write("dist/src/root.module.js", compiledModule("RootModule"));
        write("dist/root.module.js", compiledModule("RootModule"));

        expect(() => detect()).toThrow(
          new CliError(
            "src/main.ts boots RootModule from src/root.module.ts, which has been built to dist/src/root.module.js and dist/root.module.js: each is where a build from a different root directory writes it, so all but one of them are left from older builds. Pass --entry with the current one, build again into an emptied outDir, or run: nest-graph-inspector export --require ts-node/register",
          ),
        );
        expect(detect({ hasLoader: true })).toMatchObject({
          origin: "main",
          path: at("src/root.module.ts"),
        });
      });

      it("still finds app.module.js by convention, as it always has, when both are there", () => {
        const entry = write("dist/app.module.js", compiledModule("AppModule"));
        write("dist/src/app.module.js", compiledModule("AppModule"));

        expect(detect()).toMatchObject({ origin: "convention", path: entry });
      });
    });
  });

  describe("the tsconfig nest-cli.json names twice", () => {
    beforeEach(() => {
      write(
        "nest-cli.json",
        JSON.stringify({
          compilerOptions: {
            tsConfigPath: "tsconfig.app.json",
            builder: { type: "tsc", options: { configPath: "tsconfig.builder.json" } },
          },
        }),
      );
      write(
        "tsconfig.app.json",
        JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "build" } }),
      );
      write(
        "tsconfig.builder.json",
        JSON.stringify({ compilerOptions: { rootDir: "src", outDir: "out" } }),
      );
      write(
        "src/main.ts",
        mainSource('import { RootModule } from "./root.module";', "NestFactory.create(RootModule)"),
      );
      write("src/root.module.ts", moduleSource("RootModule"));
    });

    it("finds the root module where nest build writes it: tsConfigPath, before the builder's configPath", () => {
      const compiled = write("build/root.module.js", compiledModule("RootModule"));

      expect(detect()).toMatchObject({ origin: "main", path: compiled });
    });

    it("finds app.module.js where the convention always has: the builder's configPath first", () => {
      write("build/app.module.js", compiledModule("AppModule"));
      const entry = write("out/app.module.js", compiledModule("AppModule"));

      expect(detect()).toMatchObject({ origin: "convention", path: entry });
    });
  });

  describe("an SWC build", () => {
    const swc = (options: Record<string, unknown>) =>
      write(
        "nest-cli.json",
        JSON.stringify({ compilerOptions: { builder: { type: "swc", options } } }),
      );

    beforeEach(() => {
      write("tsconfig.json", JSON.stringify({ compilerOptions: { outDir: "dist" } }));
      write(
        "src/main.ts",
        mainSource('import { RootModule } from "./root.module";', "NestFactory.create(RootModule)"),
      );
      write("src/root.module.ts", moduleSource("RootModule"));
    });

    it("finds the root module in the outDir the builder's options name, over the tsconfig's", () => {
      swc({ outDir: "build" });
      // Not SWC's output: it writes to build/.
      write("dist/root.module.js", compiledModule("RootModule"));
      const compiled = write("build/root.module.js", compiledModule("RootModule"));

      expect(detect()).toMatchObject({ origin: "main", path: compiled });
    });

    it("says it was not built to that outDir", () => {
      swc({ outDir: "build" });

      expect(() => detect()).toThrow(
        new CliError(
          "No compiled RootModule found: src/main.ts boots it from src/root.module.ts, which has not been built to build/root.module.js. Build your project first (nest build), or run: nest-graph-inspector export --require ts-node/register",
        ),
      );
    });

    it("refuses the entry file SWC writes to that outDir", () => {
      swc({ outDir: "build" });
      write("build/main.js", '"use strict";\nrequire("./bootstrap").bootstrap();\n');

      expect(() => detect({ entry: "build/main.js" })).toThrow(
        new CliError(
          "build/main.js starts the application (it is the application's entry file), so the export will not load it: loading it would run your bootstrap — listen on a port, connect to a database. Point --entry at the file that exports your root module (e.g. dist/app.module.js).",
        ),
      );
    });

    it("keeps the source root in the path when the builder turns stripLeadingPaths off", () => {
      swc({ outDir: "build", stripLeadingPaths: false });
      // What stripping would give: never SWC's output here.
      write("build/root.module.js", compiledModule("RootModule"));
      const compiled = write("build/src/root.module.js", compiledModule("RootModule"));

      expect(detect()).toMatchObject({ origin: "main", path: compiled });
    });

    describe("a nested source root, which Nest CLI 12 and 11 lay out differently", () => {
      beforeEach(() => {
        write(
          "nest-cli.json",
          JSON.stringify({ sourceRoot: "apps/api/src", compilerOptions: { builder: "swc" } }),
        );
        write(
          "apps/api/src/main.ts",
          mainSource('import { RootModule } from "./root.module";', "NestFactory.create(RootModule)"),
        );
        write("apps/api/src/root.module.ts", moduleSource("RootModule"));
      });

      it.each([
        // Nest CLI 12 keeps a nested source root whole.
        ["Nest CLI 12", "dist/apps/api/src/root.module.js"],
        // Nest CLI 11 strips the first directory of the path, whatever it is.
        ["Nest CLI 11", "dist/api/src/root.module.js"],
      ])("finds what %s writes, when that is all there is", (_cli, path) => {
        const compiled = write(path, compiledModule("RootModule"));

        expect(detect()).toMatchObject({ origin: "main", path: compiled });
      });

      it("takes neither when both are there, one left from an older build", () => {
        write("dist/apps/api/src/root.module.js", compiledModule("RootModule"));
        write("dist/api/src/root.module.js", compiledModule("RootModule"));

        expect(() => detect()).toThrow(
          new CliError(
            "apps/api/src/main.ts boots RootModule from apps/api/src/root.module.ts, which SWC has built to both dist/apps/api/src/root.module.js and dist/api/src/root.module.js: Nest CLI 12 and Nest CLI 11 lay out its output differently, so one of them is left from an older build. Pass --entry with the current one, build again into an emptied outDir, or run: nest-graph-inspector export --require ts-node/register",
          ),
        );
        expect(detect({ hasLoader: true })).toMatchObject({
          origin: "main",
          path: at("apps/api/src/root.module.ts"),
        });
      });

      it("takes the one layout the builder's stripLeadingPaths names, whatever else is there", () => {
        write(
          "nest-cli.json",
          JSON.stringify({
            sourceRoot: "apps/api/src",
            compilerOptions: { builder: { type: "swc", options: { stripLeadingPaths: true } } },
          }),
        );
        write("dist/apps/api/src/root.module.js", compiledModule("RootModule"));
        const compiled = write("dist/api/src/root.module.js", compiledModule("RootModule"));

        expect(detect()).toMatchObject({ origin: "main", path: compiled });
      });
    });

    it("finds the root module with the extension the builder's options give SWC's output", () => {
      swc({ outDir: "build", outFileExtension: "cjs" });
      // Not SWC's output: it writes .cjs.
      write("build/root.module.js", compiledModule("RootModule"));
      const compiled = write("build/root.module.cjs", compiledModule("RootModule"));

      expect(detect()).toMatchObject({ origin: "main", path: compiled });
    });

    it("refuses the entry file SWC writes with that extension", () => {
      swc({ outDir: "build", outFileExtension: "cjs" });
      write("build/main.cjs", '"use strict";\nrequire("./bootstrap").bootstrap();\n');

      expect(() => detect({ entry: "build/main.cjs" })).toThrow(
        new CliError(
          "build/main.cjs starts the application (it is the application's entry file), so the export will not load it: loading it would run your bootstrap — listen on a port, connect to a database. Point --entry at the file that exports your root module (e.g. dist/app.module.js).",
        ),
      );
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

    describe("paths that name the entry file another way", () => {
      const ENTRY_FILE = (entry: string) =>
        `${entry} starts the application (it is the application's entry file), so the export will not load it: loading it would run your bootstrap — listen on a port, connect to a database. Point --entry at the file that exports your root module (e.g. dist/app.module.js).`;

      beforeEach(() => {
        write("tsconfig.json", STANDARD_TSCONFIG);
        write("src/main.ts", 'import { bootstrap } from "./bootstrap";\nvoid bootstrap();\n');
      });

      it("refuses a symlink to the entry file, and one through a symlinked directory", () => {
        const main = write("dist/main.js", '"use strict";\nrequire("./bootstrap").bootstrap();\n');
        symlinkSync(main, at("dist/server.js"));
        symlinkSync(at("dist"), at("linked"));

        for (const entry of ["dist/server.js", "linked/main.js"]) {
          expect(() => detect({ entry })).toThrow(new CliError(ENTRY_FILE(entry)));
        }
      });

      it("refuses the entry file through a symlinked outDir", () => {
        // `nest build` writes through the link; --entry names the real file.
        const main = write("build/main.js", '"use strict";\nrequire("./bootstrap").bootstrap();\n');
        symlinkSync(at("build"), at("dist"));

        expect(() => detect({ entry: "build/main.js" })).toThrow(
          new CliError(ENTRY_FILE("build/main.js")),
        );
        expect(realpathSync(at("dist/main.js"))).toBe(main);
      });

      it("loads the file it checked: a symlink's target", () => {
        const module = write("dist/app.module.js", compiledModule("AppModule"));
        symlinkSync(module, at("dist/root.js"));

        expect(detect({ entry: "dist/root.js" })).toEqual({
          origin: "entry",
          path: module,
          moduleName: undefined,
        });
      });
    });

    describe("an entry file in a directory of its own", () => {
      beforeEach(() => {
        write("tsconfig.json", STANDARD_TSCONFIG);
        write(
          "src/admin/server.ts",
          mainSource('import { ServerModule } from "../server";', "NestFactory.create(ServerModule)"),
        );
        write("src/server.ts", moduleSource("ServerModule"));
        write("dist/admin/server.js", COMPILED_MAIN);
      });

      it("loads, from a tsc build, the module file where a bundle would be named", () => {
        write("nest-cli.json", JSON.stringify({ entryFile: "admin/server" }));
        const module = write("dist/server.js", compiledModule("ServerModule"));

        expect(detect()).toMatchObject({
          origin: "main",
          path: module,
          moduleName: "ServerModule",
        });
        expect(detect({ entry: "dist/server.js" })).toEqual({
          origin: "entry",
          path: module,
          moduleName: undefined,
        });
      });

      it("refuses that path in a bundled build, whose one file it is", () => {
        write(
          "nest-cli.json",
          JSON.stringify({ entryFile: "admin/server", compilerOptions: { builder: "webpack" } }),
        );
        write("dist/server.js", compiledModule("ServerModule"));

        expect(() => detect({ entry: "dist/server.js" })).toThrow(
          new CliError(
            "dist/server.js starts the application (it is the application's entry file), so the export will not load it: loading it would run your bootstrap — listen on a port, connect to a database. Point --entry at the file that exports your root module (e.g. dist/app.module.js).",
          ),
        );
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
      ["let F;\nF = NestFactory;\nF.createApplicationContext(AppModule);", "NestFactory.createApplicationContext"],
      ["let create;\ncreate = core_1.NestFactory.create;\ncreate(AppModule);", "NestFactory.create"],
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
