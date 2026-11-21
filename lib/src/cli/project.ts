import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Type } from "@nestjs/common";
import { CliError } from "./cli-error";
import type { GraphExportBoot, NestCore } from "./export-graph";
import { displayPath, isDirectory, isFile } from "./files";
import {
  DEFAULT_SOURCE_ROOT,
  applicationSelectionError,
  everyApplication,
  outDirOf,
  parseNestCliConfig,
  readApplicationTsConfig,
  readBuildTsConfig,
  readNestCliConfig,
  selectApplication,
  type NestCliConfig,
} from "./nest-cli-config";
import {
  analyseMainFile,
  applicationEntryFiles,
  assertLoadableEntry,
  bundledMessage,
  chooseRootModule,
  conventionCheck,
  declaresRootMessage,
  forRootWarning,
  loaderCommand,
  locateRootModule,
  notBuiltMessage,
  type ApplicationLayout,
  type ConventionCheck,
} from "./root-module-detection";

export { displayPath, isDirectory, isFile } from "./files";

export const PACKAGE_NAME = "nest-graph-inspector";

/** The file a Nest project's root module conventionally lives in. */
const ROOT_MODULE_FILE = "app.module.js";

/** How deep under the output directory to look for `ROOT_MODULE_FILE`. */
const MAX_ENTRY_SEARCH_DEPTH = 6;

const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx"]);

/**
 * The metadata keys `@Module()` writes — the values of `MODULE_METADATA` in
 * `@nestjs/common/constants` — which is what makes a class a module. Spelled
 * out, rather than imported, so nothing here needs a Nest package beside the
 * CLI: delegating to the project's own copy has to work without one.
 */
const MODULE_METADATA_KEYS = new Set<unknown>([
  "imports",
  "providers",
  "controllers",
  "exports",
]);

/** What the export was asked for, and where it runs. */
export type EntryRequest = {
  projectDir: string;
  cwd: string;
  /** `--entry`, as given. */
  entry: string | undefined;
  /** `--module`. */
  module: string | undefined;
  /** `--app`: an application of a Nest CLI monorepo. */
  app: string | undefined;
  /** Whether `--require` names a module to load first — a TypeScript loader, say. */
  hasLoader: boolean;
  /** The command line, without `node` and the script: what an error suggests running is this plus a loader. */
  argv: readonly string[];
};

/** The file the export loads, the root module export to take from it, and how the export came to them. */
export type ResolvedEntry =
  /** `--entry`, as given. */
  | { origin: "entry"; path: string; moduleName: string | undefined }
  /**
   * `app.module.js` under the outDir, found as the export always has found
   * it; with what main.ts boots, when that is clear, to warn of a mismatch
   * once the root module export has been chosen.
   */
  | {
      origin: "convention";
      path: string;
      moduleName: string | undefined;
      check: ConventionCheck | undefined;
    }
  /** The root module main.ts boots, traced from its import to the file to load. */
  | {
      origin: "main";
      path: string;
      moduleName: string;
      mainFile: string;
      /** The decision, said on stderr. */
      notes: readonly string[];
      warnings: readonly string[];
    };

type Detection =
  | { kind: "found"; path: string }
  | { kind: "failed"; error: CliError };

export type InstalledPackage = {
  /** The package directory, with symlinks resolved. */
  root: string;
  version: string;
  /** The `nest-graph-inspector` bin, when this version ships one. */
  bin: string | undefined;
};

/** The copy of this package the running CLI belongs to. */
export function readOwnPackage(): InstalledPackage {
  const root = resolve(__dirname, "..", "..");
  const ownPackage = readPackage(root);
  if (!ownPackage) {
    throw new Error(`No ${PACKAGE_NAME} package.json found at ${root}`);
  }

  return ownPackage;
}

/**
 * The copy of this package the project itself installed, if any — found the
 * way the project's own `require('nest-graph-inspector')` would find it.
 */
export function findProjectPackage(
  projectRequire: NodeJS.Require,
): InstalledPackage | undefined {
  let entry: string;
  try {
    entry = projectRequire.resolve(PACKAGE_NAME);
  } catch {
    return undefined;
  }

  for (let dir = dirname(entry); ; dir = dirname(dir)) {
    const found = readPackage(dir);
    if (found) {
      return found;
    }

    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}

function readPackage(dir: string): InstalledPackage | undefined {
  const packageJsonPath = join(dir, "package.json");
  if (!isFile(packageJsonPath)) {
    return undefined;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
    bin?: unknown;
  };
  if (packageJson.name !== PACKAGE_NAME) {
    return undefined;
  }

  const bin =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : (packageJson.bin as Record<string, unknown> | undefined)?.[
          PACKAGE_NAME
        ];

  return {
    root: realpathSync(dir),
    version: String(packageJson.version),
    bin: typeof bin === "string" ? resolve(dir, bin) : undefined,
  };
}

/**
 * The file the export loads, and the root module export to take from it.
 *
 * `--entry` is taken as given, and main.ts is not read. Otherwise the
 * conventional `app.module.js` under the outDir is used when there is exactly
 * one, as it always has been; failing that, the root module main.ts passes to
 * `NestFactory`, found by parsing main.ts — never by loading it. `--app` does
 * the same within one application of a Nest CLI monorepo. However it was
 * found, a file that would start the application is refused before anything
 * is loaded.
 */
export function resolveEntry(request: EntryRequest): ResolvedEntry {
  if (request.entry) {
    return resolveGivenEntry(request, request.entry);
  }

  const config = readNestCliConfig(request.projectDir);
  return request.app === undefined
    ? resolveDefaultEntry(request, config)
    : resolveApplicationEntry(request, config, request.app);
}

function resolveGivenEntry(request: EntryRequest, entry: string): ResolvedEntry {
  const { cwd, projectDir } = request;
  const path = resolve(cwd, entry);
  if (!isFile(path)) {
    throw new CliError(
      `Entry file not found: ${displayPath(path, cwd)}. Check the --entry path, and build your project first (nest build) if it points at compiled output.`,
    );
  }

  assertLoadableEntry(path, entryFilesOfEveryApplication(projectDir, cwd), cwd);

  if (isTypeScriptFile(path) && !request.hasLoader) {
    throw new CliError(
      `${displayPath(path, cwd)} is TypeScript, which Node cannot load on its own. ` +
        "Build your project and pass the compiled file, or add a loader that emits decorator metadata: " +
        "--require ts-node/register (and --require tsconfig-paths/register for path aliases).",
    );
  }

  return { origin: "entry", path, moduleName: request.module };
}

/**
 * Without `--entry` or `--app`: the convention first, unchanged, so a project
 * it finds an entry for exports exactly what it always has; main.ts only when
 * the convention finds none, or several.
 */
function resolveDefaultEntry(
  request: EntryRequest,
  config: NestCliConfig,
): ResolvedEntry {
  const { cwd, projectDir } = request;
  const convention = detect(() =>
    detectConventionalEntry(projectDir, config, cwd),
  );
  if (convention.kind === "found") {
    assertLoadableEntry(
      convention.path,
      entryFilesOfEveryApplication(projectDir, cwd, config),
      cwd,
    );
    return {
      origin: "convention",
      path: convention.path,
      moduleName: request.module,
      check: defaultConventionCheck(projectDir, config, cwd),
    };
  }

  const selection = selectApplication(config, undefined);
  if (selection.kind !== "selected") {
    throw applicationSelectionError(selection, config);
  }

  let layout: ApplicationLayout;
  try {
    layout = {
      projectDir,
      application: selection.application,
      tsconfig: readApplicationTsConfig(projectDir, selection.application, cwd),
    };
  } catch (error) {
    // The convention reads a tsconfig as well, and has said what it could not.
    throw error instanceof CliError ? convention.error : error;
  }

  return resolveFromMainFile(request, layout, selection.note, convention.error);
}

/** `--app <name>`: the convention within that application's outDir, then its main.ts. */
function resolveApplicationEntry(
  request: EntryRequest,
  config: NestCliConfig,
  app: string,
): ResolvedEntry {
  const { cwd, projectDir } = request;
  const selection = selectApplication(config, app);
  if (selection.kind !== "selected") {
    throw applicationSelectionError(selection, config);
  }

  const { application } = selection;
  const layout: ApplicationLayout = {
    projectDir,
    application,
    tsconfig: readApplicationTsConfig(projectDir, application, cwd),
  };
  const convention = detect(() =>
    detectEntryUnder(outDirOf(projectDir, layout.tsconfig), application.sourceRoot, cwd),
  );
  if (convention.kind === "found") {
    assertLoadableEntry(
      convention.path,
      entryFilesOfEveryApplication(projectDir, cwd, config),
      cwd,
    );
    return {
      origin: "convention",
      path: convention.path,
      moduleName: request.module,
      check: conventionCheck(layout),
    };
  }

  return resolveFromMainFile(request, layout, selection.note, convention.error);
}

/**
 * The root module main.ts boots, and the file to load it from. When main.ts
 * names no root module the export can follow, the convention's own error
 * stands, as it did before main.ts was read.
 */
function resolveFromMainFile(
  request: EntryRequest,
  layout: ApplicationLayout,
  selectionNote: string | undefined,
  conventionError: CliError,
): ResolvedEntry {
  const { cwd } = request;
  const analysis = analyseMainFile(layout);
  if (analysis.kind === "unknown") {
    throw conventionError;
  }

  if (analysis.kind === "declares-root") {
    throw new CliError(declaresRootMessage(analysis.mainFile, analysis.name, cwd));
  }

  const choice = chooseRootModule(analysis, request.module, cwd);
  if (choice.kind === "ambiguous") {
    throw new CliError(choice.message);
  }

  const { root, moduleName } = choice;
  const located = locateRootModule(root, layout, request.hasLoader);
  if (located.kind === "not-built") {
    throw new CliError(
      notBuiltMessage({
        mainFile: analysis.mainFile,
        root,
        candidates: located.candidates,
        command: loaderCommand(request.argv, layout.tsconfig),
        cwd,
      }),
    );
  }

  if (located.kind === "bundled") {
    throw new CliError(
      bundledMessage({
        application: layout.application,
        bundler: located.bundler,
        root,
        command: loaderCommand(request.argv, layout.tsconfig),
        cwd,
      }),
    );
  }

  assertLoadableEntry(
    located.path,
    entryFilesOfEveryApplication(layout.projectDir, cwd),
    cwd,
  );
  const forRoot =
    moduleName === root.exportName
      ? forRootWarning(analysis.mainFile, root, cwd)
      : undefined;

  return {
    origin: "main",
    path: located.path,
    moduleName,
    mainFile: analysis.mainFile,
    notes: [
      ...(selectionNote === undefined ? [] : [selectionNote]),
      `entry ${displayPath(located.path, cwd)} (${moduleName}, from ${displayPath(analysis.mainFile, cwd)})`,
    ],
    warnings: forRoot === undefined ? [] : [forRoot],
  };
}

function detect(find: () => string): Detection {
  try {
    return { kind: "found", path: find() };
  } catch (error) {
    if (error instanceof CliError) {
      return { kind: "failed", error };
    }

    throw error;
  }
}

/**
 * What main.ts boots in the default project, to check an entry found by
 * convention against. Only ever feeds a warning, so whatever cannot be read
 * gives none.
 */
function defaultConventionCheck(
  projectDir: string,
  config: NestCliConfig,
  cwd: string,
): ConventionCheck | undefined {
  try {
    const selection = selectApplication(config, undefined);
    return selection.kind === "selected"
      ? conventionCheck({
          projectDir,
          application: selection.application,
          tsconfig: readApplicationTsConfig(projectDir, selection.application, cwd),
        })
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The entry files of the default project and of every named application, as
 * far as they can be worked out. A configuration that cannot be read costs
 * this list its paths, never the export: the check for `NestFactory` calls
 * runs on the file regardless.
 */
function entryFilesOfEveryApplication(
  projectDir: string,
  cwd: string,
  known?: NestCliConfig,
): string[] {
  const config = known ?? readNestCliConfigOrDefaults(projectDir);

  return everyApplication(config).flatMap((application) => {
    let tsconfig: ApplicationLayout["tsconfig"];
    try {
      tsconfig = readApplicationTsConfig(projectDir, application, cwd);
    } catch {
      tsconfig = undefined;
    }

    return applicationEntryFiles({ projectDir, application, tsconfig });
  });
}

function readNestCliConfigOrDefaults(projectDir: string): NestCliConfig {
  try {
    return readNestCliConfig(projectDir);
  } catch {
    return parseNestCliConfig(undefined, undefined);
  }
}

/**
 * The compiled file exporting the project's root module, found the way
 * `nest build` lays out its output: `<outDir>/app.module.js`, or
 * `<outDir>/<sourceRoot>/app.module.js` when the TypeScript root directory is
 * the project rather than the source root. Failing both, the one
 * `app.module.js` anywhere under the output directory.
 */
export function detectEntry(projectDir: string, cwd: string): string {
  return detectConventionalEntry(projectDir, readNestCliConfig(projectDir), cwd);
}

function detectConventionalEntry(
  projectDir: string,
  config: NestCliConfig,
  cwd: string,
): string {
  // The convention reads a tsc builder's configPath ahead of tsConfigPath.
  const tsconfig = readBuildTsConfig(
    projectDir,
    config.compilerOptions.builder?.configPath ??
      config.compilerOptions.tsConfigPath,
    cwd,
  );

  return detectEntryUnder(
    outDirOf(projectDir, tsconfig),
    config.sourceRoot ?? DEFAULT_SOURCE_ROOT,
    cwd,
  );
}

function detectEntryUnder(
  outDir: string,
  sourceRoot: string,
  cwd: string,
): string {
  const candidates = [
    ...new Set([
      join(outDir, ROOT_MODULE_FILE),
      join(outDir, sourceRoot, ROOT_MODULE_FILE),
    ]),
  ];
  const buildHint =
    "Build your project first (nest build), or pass --entry <file>.";

  const candidate = candidates.find(isFile);
  if (candidate) {
    return candidate;
  }

  if (!isDirectory(outDir)) {
    throw new CliError(
      `No compiled application found: ${displayPath(outDir, cwd)} does not exist. ${buildHint}`,
    );
  }

  const found = findFiles(outDir, ROOT_MODULE_FILE, MAX_ENTRY_SEARCH_DEPTH);
  if (found.length === 1) {
    return found[0];
  }

  if (found.length > 1) {
    throw new CliError(
      `Found ${found.length} ${ROOT_MODULE_FILE} files under ${displayPath(outDir, cwd)} (${found
        .map((path) => displayPath(path, cwd))
        .join(", ")}). Pass --entry <file> to choose one.`,
    );
  }

  throw new CliError(
    `No ${ROOT_MODULE_FILE} found under ${displayPath(outDir, cwd)} (looked for ${candidates
      .map((path) => displayPath(path, cwd))
      .join(" and ")}). ${buildHint}`,
  );
}

function findFiles(dir: string, fileName: string, depth: number): string[] {
  if (depth < 0) {
    return [];
  }

  return readdirSync(dir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (entry.isFile() && entry.name === fileName) {
        return [join(dir, entry.name)];
      }

      return entry.isDirectory() &&
        entry.name !== "node_modules" &&
        !entry.name.startsWith(".")
        ? findFiles(join(dir, entry.name), fileName, depth - 1)
        : [];
    });
}

export function isTypeScriptFile(path: string): boolean {
  return TYPESCRIPT_EXTENSIONS.has(extname(path));
}

/**
 * Loads a module the way Node would from the project: `import()` for an ES
 * module, which `require()` cannot load on every supported Node version, and
 * `require()` — through any `--require` hooks — for everything else. Decided
 * before loading rather than by retrying, so a module file is never run twice.
 */
export async function loadModule(
  path: string,
  projectRequire: NodeJS.Require,
): Promise<unknown> {
  if (isEsModule(path)) {
    return await importModule(pathToFileURL(path).href);
  }

  return projectRequire(path) as unknown;
}

/**
 * Whether Node treats a file as an ES module: `.mjs` and `.mts` always,
 * `.cjs` and `.cts` never, and `.js` when its nearest package.json says
 * `"type": "module"`. Other extensions — `.ts` with a `--require` loader —
 * are left to `require()`.
 */
export function isEsModule(path: string): boolean {
  const extension = extname(path);
  if (extension === ".mjs" || extension === ".mts") {
    return true;
  }

  if (extension !== ".js") {
    return false;
  }

  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const packageJsonPath = join(dir, "package.json");
    if (isFile(packageJsonPath)) {
      try {
        const { type } = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          type?: unknown;
        };
        return type === "module";
      } catch {
        return false;
      }
    }

    if (dirname(dir) === dir) {
      return false;
    }
  }
}

// TypeScript compiles `import()` to `require()` in CommonJS output, which
// cannot load an ES module; a function built at runtime keeps the real one.
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const importModule = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<unknown>;

/**
 * The root module class among a module's exports: the one named `name`, or —
 * when no name was asked for and there is no `AppModule`, or the `AppModule`
 * export is not a Nest module — the only exported class carrying `@Module()`
 * metadata.
 */
export function selectEntryModule(
  moduleExports: unknown,
  requestedName: string | undefined,
  entryPath: string,
  cwd: string,
): { name: string; module: Type<unknown> } {
  const exported = (
    typeof moduleExports === "function"
      ? { default: moduleExports }
      : (moduleExports ?? {})
  ) as Record<string, unknown>;
  const name = requestedName ?? "AppModule";
  const candidate = exported[name];
  const modules = Object.entries(exported).filter(
    (entry): entry is [string, Type<unknown>] => isNestModuleClass(entry[1]),
  );

  // An explicit --module is taken at its word. The default `AppModule` gives
  // way to the one export that is a Nest module when it is not one itself —
  // a function that only shares the name. It is still taken otherwise:
  // `@Module({})` with nothing in it defines no metadata to recognise.
  const appModuleGivesWay =
    !requestedName && !isNestModuleClass(candidate) && modules.length === 1;
  if (typeof candidate === "function" && !appModuleGivesWay) {
    return { name, module: candidate as Type<unknown> };
  }
  const file = displayPath(entryPath, cwd);
  const exportedModules = modules.length
    ? `It exports these Nest modules: ${modules.map(([exportName]) => exportName).join(", ")}.`
    : "It exports no Nest module (a class decorated with @Module()).";

  if (!requestedName && modules.length === 1) {
    const [exportName, module] = modules[0];
    return { name: exportName, module };
  }

  if (!requestedName && modules.length > 1) {
    throw new CliError(
      `${file} does not export AppModule. ${exportedModules} Pass --module <name> to choose one.`,
    );
  }

  throw new CliError(
    `${file} has no export named ${name}. ${exportedModules} Pass --entry <file> and --module <name> for the file and export of your root module.`,
  );
}

function isNestModuleClass(value: unknown): value is Type<unknown> {
  return (
    typeof value === "function" &&
    Reflect.getMetadataKeys(value).some((key) => MODULE_METADATA_KEYS.has(key))
  );
}

/**
 * Loads the project's own `@nestjs/core`, with the project's
 * `reflect-metadata` ahead of it when the project depends on it directly.
 */
export function loadNestCore(
  projectRequire: NodeJS.Require,
  projectDir: string,
  cwd: string,
): { nestCore: NestCore; boot: GraphExportBoot } {
  let reflectMetadata: string | undefined;
  try {
    reflectMetadata = projectRequire.resolve("reflect-metadata");
  } catch {
    // Not a direct dependency: @nestjs/core loads its own below.
  }
  if (reflectMetadata) {
    projectRequire(reflectMetadata);
  }

  let entry: string;
  try {
    entry = projectRequire.resolve("@nestjs/core");
  } catch {
    throw new CliError(
      `Cannot find @nestjs/core from ${displayPath(projectDir, cwd)}. Run the export from your NestJS project, or pass --project <dir>.`,
    );
  }

  return {
    nestCore: projectRequire(entry) as NestCore,
    boot: canLoadHttpPlatform(entry) ? "application" : "application-context",
  };
}

/**
 * Whether `@nestjs/core` can load the HTTP platform `NestFactory.create()`
 * defaults to, resolved from where Nest itself resolves it.
 */
function canLoadHttpPlatform(nestCoreEntry: string): boolean {
  try {
    createRequire(nestCoreEntry).resolve("@nestjs/platform-express");
    return true;
  } catch {
    return false;
  }
}
