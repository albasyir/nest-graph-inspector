import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Type } from "@nestjs/common";
import {
  buildAdvice,
  conventionalEntryCandidates,
  conventionalEntrySource,
  outDirOf,
  pickCompiled,
  sharedWith,
  staleBuildsReason,
} from "./build-output";
import { CliError } from "./cli-error";
import { conventionCheck, conventionWarnings, type ConventionCheck } from "./convention-check";
import type { GraphExportBoot, NestCore } from "./export-graph";
import { displayPath, isDirectory, isFile, joinedPaths, samePath } from "./files";
import { assertLoadableEntry, type LoadableFile } from "./load-guard";
import {
  DEFAULT_SOURCE_ROOT,
  applicationSelectionError,
  conventionEntryNote,
  readApplicationLayout,
  readBuildTsConfig,
  readEveryLayout,
  readNestCliConfig,
  selectApplication,
  type ApplicationLayout,
  type ApplicationSelection,
  type NestApplication,
  type NestCliConfig,
} from "./nest-cli-config";
import { entryFromMainFile } from "./root-module-detection";

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

export type EntryRequest = {
  projectDir: string;
  cwd: string;
  entry: string | undefined;
  module: string | undefined;
  /** An application of a Nest CLI monorepo. */
  app: string | undefined;
  /** Whether `--require` names a module to load first — a TypeScript loader, say. */
  hasLoader: boolean;
  /** The command line without `node` and the script, which a message suggests again with a loader. */
  argv: readonly string[];
};

/** The file to load, the root module export to take, and what to say, before loading, of how they were found. */
export type ResolvedEntry = {
  path: LoadableFile;
  notes: readonly string[];
  warnings: readonly string[];
} & (
  | { origin: "entry"; moduleName: string | undefined }
  | {
      origin: "convention";
      moduleName: string | undefined;
      /** What main.ts boots, to warn of a mismatch once the root module export is chosen. */
      check: ConventionCheck | undefined;
    }
  | { origin: "main"; moduleName: string; mainFile: string }
);

type Detection = { kind: "found"; path: string } | { kind: "failed"; error: CliError };

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
 * `--entry` is taken as given, main.ts unread. Otherwise the `app.module.js`
 * convention decides as it always has — for `--app`, only that application's
 * own file — and failing it, the root module main.ts passes to `NestFactory`.
 * Whichever file is found goes through the load guard before it is loaded.
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

  const path = assertLoadableEntry(given, { projectDir, cwd });
  if (isTypeScriptFile(path) && !request.hasLoader) {
    throw new CliError(
      `${displayPath(given, cwd)} is TypeScript, which Node cannot load on its own. ` +
        "Build your project and pass the compiled file, or add a loader that emits decorator metadata: " +
        "--require ts-node/register (and --require tsconfig-paths/register for path aliases).",
    );
  }

  return { origin: "entry", path, moduleName: request.module, notes: [], warnings: [] };
}

/** The convention first, unchanged, so a project it finds an entry for exports exactly what it always has. */
function resolveDefaultEntry(request: EntryRequest, config: NestCliConfig): ResolvedEntry {
  const { cwd, projectDir } = request;
  const selection = selectApplication(config, undefined);
  const convention = detect(() => detectConventionalEntry(projectDir, config, cwd));
  if (convention.kind === "found") {
    const path = assertLoadableEntry(convention.path, { projectDir, cwd });
    // Only ever for a warning or a note: an unreadable tsconfig gives neither.
    const layout =
      selection.kind === "selected"
        ? readLayoutIfReadable(projectDir, selection.application, cwd)
        : undefined;
    return {
      origin: "convention",
      path,
      moduleName: request.module,
      check:
        layout === undefined
          ? undefined
          : conventionCheck(layout, () => otherApplicationLayouts(layout, config, cwd)),
      notes: conventionNotes({ config, selection, layout, path, cwd }),
      warnings: [],
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

/** Its outDir is never searched, as the project's is without `--app`: an `app.module.js` there could be another application's. */
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
      path: assertLoadableEntry(convention.path, { projectDir, cwd }),
      moduleName: request.module,
      check: conventionCheck(layout, () => otherApplicationLayouts(layout, config, cwd)),
      notes: [],
      warnings: [],
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

/** When main.ts names no root module the export can follow, the convention's own error stands, as before main.ts was read. */
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
  const booted = entryFromMainFile({
    layout,
    others: otherApplicationLayouts(layout, config, cwd),
    module: request.module,
    hasLoader: request.hasLoader,
    argv: request.argv,
    app: request.app,
    cwd,
  });
  if (booted === undefined) {
    throw conventionError;
  }

  const { moduleName, mainFile } = booted;
  const path = assertLoadableEntry(booted.file, { projectDir: layout.projectDir, cwd });
  return {
    origin: "main",
    path,
    moduleName,
    mainFile,
    notes: [
      ...(selectionNote === undefined ? [] : [selectionNote]),
      `entry ${displayPath(path, cwd)} (${moduleName}, from ${displayPath(mainFile, cwd)})`,
      ...booted.skipped,
    ],
    warnings: booted.warnings,
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
 * Among named applications: the default project's note when the file is
 * plainly that project's own output, else which file it is.
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
      ownedConventionalEntries(layout, config, cwd).some((candidate) => samePath(candidate, path));
    if (owned) {
      return [note];
    }
  }

  return [conventionEntryNote(config, displayPath(path, cwd))];
}

/**
 * `--app`'s own `app.module.js`. Which candidates exist is settled first —
 * more than one means all but one are stale — and only then whose the one
 * there is: not another application's conventional path, nor a file its build
 * compiles a source outside its sourceRoot to (`sharedWith`, as for main.ts's
 * root module). When none is taken, the reason stands for main.ts to fall
 * back on.
 */
function detectApplicationEntry(
  layout: ApplicationLayout,
  config: NestCliConfig,
  cwd: string,
  app: string,
): Detection {
  const candidates = conventionalEntryCandidates(layout);
  const { build } = layout.application;
  const failed = (message: string): Detection => ({ kind: "failed", error: new CliError(message) });
  const compiled = pickCompiled(candidates);
  switch (compiled.kind) {
    case "found":
      return ownedConventionalEntries(layout, config, cwd).some((owned) =>
        samePath(owned, compiled.path),
      ) &&
        sharedWith(compiled.path, conventionalEntrySource(layout), otherApplicationLayouts(layout, config, cwd)) ===
          undefined
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

/** Where an application's build writes its `app.module.js`, less any path another application's build could write its own to. */
function ownedConventionalEntries(
  layout: ApplicationLayout,
  config: NestCliConfig,
  cwd: string,
): string[] {
  const others = otherApplicationLayouts(layout, config, cwd).flatMap(conventionalEntryCandidates);

  return conventionalEntryCandidates(layout).filter(
    (candidate) => !others.some((other) => samePath(other, candidate)),
  );
}

/** The project's other applications — those with a source root of their own — whose builds could write where this one's does. */
function otherApplicationLayouts(
  layout: ApplicationLayout,
  config: NestCliConfig,
  cwd: string,
): ApplicationLayout[] {
  // Without projects the application is the only one: no tsconfig to read.
  if (config.projects.size === 0) {
    return [];
  }

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

function detectConventionalEntry(projectDir: string, config: NestCliConfig, cwd: string): string {
  const sourceRoot = config.sourceRoot ?? DEFAULT_SOURCE_ROOT;
  const outDir = outDirOf(
    projectDir,
    readBuildTsConfig(projectDir, config.conventionTsConfigPath, cwd),
  );
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
  path: LoadableFile,
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

/** `selectEntryModule`'s pick, and — for an entry found by convention — the warnings the convention check gives. */
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
          { path: entry.path, moduleName: selected.name, requestedModule: entry.moduleName },
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
