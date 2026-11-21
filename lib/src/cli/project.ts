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
  conventionEntryNote,
  outDirOf,
  readApplicationLayout,
  readConventionTsConfig,
  readEveryLayout,
  readNestCliConfig,
  readNestCliConfigOrDefaults,
  selectApplication,
  type ApplicationLayout,
  type ApplicationSelection,
  type NestApplication,
  type NestCliConfig,
} from "./nest-cli-config";
import {
  analyseMainFile,
  assertLoadableEntry,
  buildAdvice,
  bundledMessage,
  chooseRootModule,
  conventionCheck,
  conventionalEntryCandidates,
  conventionWarnings,
  declaresRootMessage,
  forRootWarning,
  joinedPaths,
  loaderCommand,
  locateRootModule,
  notBuiltMessage,
  pickCompiled,
  samePath,
  severalBuildsMessage,
  sharedOutputMessage,
  staleBuildsReason,
  type BootedRootModule,
  type ConventionCheck,
  type RootModuleEntry,
  type SkippedBoot,
} from "./root-module-detection";

export const PACKAGE_NAME = "nest-graph-inspector";

/** The file a Nest project's root module conventionally lives in. */
const ROOT_MODULE_FILE = "app.module.js";

/** How deep under the output directory to look for `ROOT_MODULE_FILE`. */
const MAX_ENTRY_SEARCH_DEPTH = 6;

const BUILD_HINT = "Build your project first (nest build), or pass --entry <file>.";

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

/**
 * The file the export loads — symlinks resolved, as it was checked — the root
 * module export to take from it, and how the export came to them.
 */
export type ResolvedEntry =
  /** `--entry`, as given. */
  | { origin: "entry"; path: string; moduleName: string | undefined }
  /**
   * `app.module.js` under the outDir, found as the export always has found
   * it — or, for `--app`, the application's own; with what main.ts boots,
   * when that is clear, to warn of a mismatch once the root module export has
   * been chosen.
   */
  | {
      origin: "convention";
      path: string;
      moduleName: string | undefined;
      check: ConventionCheck | undefined;
      /** Among named applications without `--app`, which one it is: said on stderr. */
      notes: readonly string[];
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
 * the same within one application of a Nest CLI monorepo, taking only an
 * `app.module.js` that is plainly that application's own. However it was
 * found, the file is checked before anything is loaded, and refused when it
 * would start the application; the modules it imports are not checked.
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
  const given = resolve(cwd, entry);
  if (!isFile(given)) {
    throw new CliError(
      `Entry file not found: ${displayPath(given, cwd)}. Check the --entry path, and build your project first (nest build) if it points at compiled output.`,
    );
  }

  const path = assertLoadableEntry(given, {
    projectDir,
    cwd,
    config: readNestCliConfigOrDefaults(projectDir),
  });

  if (isTypeScriptFile(path) && !request.hasLoader) {
    throw new CliError(
      `${displayPath(given, cwd)} is TypeScript, which Node cannot load on its own. ` +
        "Build your project and pass the compiled file, or add a loader that emits decorator metadata: " +
        "--require ts-node/register (and --require tsconfig-paths/register for path aliases).",
    );
  }

  return { origin: "entry", path, moduleName: request.module };
}

/**
 * Without `--entry` or `--app`: the convention first, unchanged, so a project
 * it finds an entry for exports exactly what it always has; main.ts only when
 * the convention finds none, or several. Among named applications, an entry
 * found by convention says which one it is.
 */
function resolveDefaultEntry(
  request: EntryRequest,
  config: NestCliConfig,
): ResolvedEntry {
  const { cwd, projectDir } = request;
  const selection = selectApplication(config, undefined);
  const convention = detect(() =>
    detectConventionalEntry(projectDir, config, cwd),
  );
  if (convention.kind === "found") {
    const path = assertLoadableEntry(convention.path, { projectDir, cwd, config });
    // Only ever for a warning or a note: a default project whose tsconfig
    // cannot be read gives neither.
    const layout =
      selection.kind === "selected"
        ? readLayoutIfReadable(projectDir, selection.application, cwd)
        : undefined;
    return {
      origin: "convention",
      path,
      moduleName: request.module,
      check: layout === undefined ? undefined : conventionCheck(layout),
      notes: conventionNotes({ config, selection, layout, path, cwd }),
    };
  }

  if (selection.kind !== "selected") {
    throw applicationSelectionError(selection, config);
  }

  return resolveFromMainFile({
    request,
    config,
    layout: readApplicationLayout(projectDir, selection.application, cwd),
    selectionNote: selection.note,
    conventionError: convention.error,
  });
}

/**
 * `--app <name>`: that application's own `app.module.js`, else its main.ts.
 * Its outDir is not searched, as the project's is without `--app`: an
 * `app.module.js` found there could be another application's.
 */
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

  const layout = readApplicationLayout(projectDir, selection.application, cwd);
  const convention = detectApplicationEntry(layout, config, cwd, app);
  if (convention.kind === "found") {
    return {
      origin: "convention",
      path: assertLoadableEntry(convention.path, { projectDir, cwd, config }),
      moduleName: request.module,
      check: conventionCheck(layout),
      notes: [],
    };
  }

  return resolveFromMainFile({
    request,
    config,
    layout,
    selectionNote: selection.note,
    conventionError: convention.error,
  });
}

/**
 * The root module main.ts boots, and the file to load it from. When main.ts
 * names no root module the export can follow, the convention's own error
 * stands, as it did before main.ts was read.
 */
function resolveFromMainFile({
  request,
  config,
  layout,
  selectionNote,
  conventionError,
}: {
  request: EntryRequest;
  config: NestCliConfig;
  layout: ApplicationLayout;
  selectionNote: string | undefined;
  conventionError: CliError;
}): ResolvedEntry {
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
  const located = locateRootModule(
    root,
    layout,
    request.hasLoader,
    otherApplicationLayouts(layout, config, cwd),
  );
  if (located.kind !== "compiled" && located.kind !== "source") {
    throw new CliError(
      unlocatedMessage(located, { request, layout, mainFile: analysis.mainFile, root }),
    );
  }

  const path = assertLoadableEntry(located.path, {
    projectDir: layout.projectDir,
    cwd,
    config,
  });
  const forRoot =
    moduleName === root.exportName
      ? forRootWarning(analysis.mainFile, root, cwd)
      : undefined;

  return {
    origin: "main",
    path,
    moduleName,
    mainFile: analysis.mainFile,
    notes: [
      ...(selectionNote === undefined ? [] : [selectionNote]),
      `entry ${displayPath(path, cwd)} (${moduleName}, from ${displayPath(analysis.mainFile, cwd)})`,
      ...analysis.skipped.map((skipped) => skippedBootNote(analysis.mainFile, skipped, cwd)),
    ],
    warnings: forRoot === undefined ? [] : [forRoot],
  };
}

/**
 * A boot main.ts makes that the export passed over, said so the choice it
 * made is plain: its root module is only known at runtime, or comes from a
 * package.
 */
function skippedBootNote(mainFile: string, skipped: SkippedBoot, cwd: string): string {
  return `skipped ${displayPath(mainFile, cwd)}:${skipped.line} ${skipped.call}: its root module is not an import the export can follow`;
}

/** Why the root module main.ts boots has no file the export will load, and what to do. */
function unlocatedMessage(
  located: Exclude<RootModuleEntry, { kind: "compiled" | "source" }>,
  context: {
    request: EntryRequest;
    layout: ApplicationLayout;
    mainFile: string;
    root: BootedRootModule;
  },
): string {
  const { request, layout, mainFile, root } = context;
  const { cwd } = request;
  const command = loaderCommand(request.argv, layout);
  switch (located.kind) {
    case "not-built":
      return notBuiltMessage({
        mainFile,
        root,
        candidates: located.candidates,
        command,
        app: request.app,
        cwd,
      });
    case "bundled":
      return bundledMessage({
        application: layout.application,
        bundler: located.bundler,
        root,
        command,
        cwd,
      });
    case "several":
      return severalBuildsMessage({
        mainFile,
        root,
        paths: located.paths,
        build: layout.application.build,
        command,
        cwd,
      });
    case "shared":
      return sharedOutputMessage({
        mainFile,
        root,
        path: located.path,
        otherSource: located.otherSource,
        command,
        cwd,
      });
    default: {
      const _exhaustive: never = located;
      return _exhaustive;
    }
  }
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

/** An application with its tsconfig; undefined when that tsconfig cannot be read. */
function readLayoutIfReadable(
  projectDir: string,
  application: NestApplication,
  cwd: string,
): ApplicationLayout | undefined {
  try {
    return readApplicationLayout(projectDir, application, cwd);
  } catch (error) {
    if (error instanceof CliError) {
      return undefined;
    }

    throw error;
  }
}

/**
 * What an entry found by convention without `--app` says on stderr, among
 * named applications: the default project's note when the file is plainly
 * that project's own output, and otherwise which file it is. Nothing when the
 * project has one application.
 */
function conventionNotes(found: {
  config: NestCliConfig;
  selection: ApplicationSelection;
  layout: ApplicationLayout | undefined;
  path: string;
  cwd: string;
}): string[] {
  const { config, selection, layout, path, cwd } = found;
  if (selection.kind === "selected") {
    const { note } = selection;
    if (note === undefined) {
      return [];
    }

    const owned =
      layout !== undefined &&
      ownedConventionalEntries(layout, config, cwd).some((candidate) =>
        samePath(candidate, path),
      );
    if (owned) {
      return [note];
    }
  }

  return [conventionEntryNote(config, displayPath(path, cwd))];
}

/**
 * `--app`'s conventional `app.module.js`: the one of its candidates that
 * exists, when it is plainly the application's own. Which exist is settled
 * first — more than one means all but one are stale, and none is taken —
 * and only then whose the one there is. When none is taken, why — for main.ts's
 * analysis to fall back on.
 */
function detectApplicationEntry(
  layout: ApplicationLayout,
  config: NestCliConfig,
  cwd: string,
  app: string,
): Detection {
  const candidates = conventionalEntryCandidates(layout);
  const { build } = layout.application;
  const failed = (message: string): Detection => ({
    kind: "failed",
    error: new CliError(message),
  });
  const compiled = pickCompiled(candidates);
  switch (compiled.kind) {
    case "found":
      return ownedConventionalEntries(layout, config, cwd).some((owned) =>
        samePath(owned, compiled.path),
      )
        ? { kind: "found", path: compiled.path }
        : failed(
            `${displayPath(compiled.path, cwd)} is where ${app}'s build writes its ${ROOT_MODULE_FILE}, but another application's build writes its own there too, so whose it is cannot be told. Pass --entry <file>.`,
          );
    case "several": {
      const built =
        build.kind === "swc"
          ? `SWC has built ${app}'s ${ROOT_MODULE_FILE} to both`
          : `${app}'s ${ROOT_MODULE_FILE} has been built to`;
      return failed(
        `${built} ${joinedPaths(compiled.paths, cwd)}: ${staleBuildsReason(build)}. Pass --entry with the current one, or build again into an emptied outDir.`,
      );
    }
    case "missing": {
      const lookedFor = candidates.length
        ? ` (looked for ${candidates.map((path) => displayPath(path, cwd)).join(", ")})`
        : "";
      return failed(
        `No compiled ${ROOT_MODULE_FILE} found for ${app}${lookedFor}. ${buildAdvice(app)}, or pass --entry <file>.`,
      );
    }
    default: {
      const _exhaustive: never = compiled;
      return _exhaustive;
    }
  }
}

/**
 * The `app.module.js` files that are plainly an application's own output:
 * where its build writes `<sourceRoot>/app.module.ts`
 * (`conventionalEntryCandidates`), less any path another application's
 * build could write its own to — a file there could be either's.
 */
function ownedConventionalEntries(
  layout: ApplicationLayout,
  config: NestCliConfig,
  cwd: string,
): string[] {
  const others = otherApplicationLayouts(layout, config, cwd).flatMap(
    conventionalEntryCandidates,
  );

  return conventionalEntryCandidates(layout).filter(
    (candidate) => !others.some((other) => samePath(other, candidate)),
  );
}

/**
 * The project's applications other than `layout`'s — those with sources of
 * their own — whose builds could write where its build does.
 */
function otherApplicationLayouts(
  layout: ApplicationLayout,
  config: NestCliConfig,
  cwd: string,
): ApplicationLayout[] {
  const { application, projectDir } = layout;
  const sources = resolve(projectDir, application.sourceRoot);
  return readEveryLayout(projectDir, config, cwd).filter(
    (other) => !samePath(resolve(projectDir, other.application.sourceRoot), sources),
  );
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
  return detectEntryUnder(
    outDirOf(projectDir, readConventionTsConfig(projectDir, config, cwd)),
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

  const candidate = candidates.find(isFile);
  if (candidate) {
    return candidate;
  }

  if (!isDirectory(outDir)) {
    throw new CliError(
      `No compiled application found: ${displayPath(outDir, cwd)} does not exist. ${BUILD_HINT}`,
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
      .join(" and ")}). ${BUILD_HINT}`,
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

/** Whether a file is TypeScript, which Node loads only through a `--require` loader. */
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

/**
 * The root module export to boot from the loaded entry — the one its module
 * name names, as `selectEntryModule` picks it — and what the export warns of
 * once it is known: for an entry found by convention, that main.ts boots a
 * different module, or boots this one through `forRoot()`.
 */
export function selectRootModule(
  entry: ResolvedEntry,
  moduleExports: unknown,
  cwd: string,
): { name: string; module: Type<unknown>; warnings: string[] } {
  const selected = selectEntryModule(moduleExports, entry.moduleName, entry.path, cwd);
  const warnings =
    entry.origin === "convention" && entry.check
      ? conventionWarnings(
          entry.check,
          {
            path: entry.path,
            moduleName: selected.name,
            requestedModule: entry.moduleName,
          },
          cwd,
        )
      : [];

  return { ...selected, warnings };
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
