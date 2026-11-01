import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";
import type { Type } from "@nestjs/common";
import { ts } from "ts-morph";
import { CliError, describeError } from "./cli-error";
import type { GraphExportBoot, NestCore } from "./export-graph";

export const PACKAGE_NAME = "nest-graph-inspector";

/** The files the Nest CLI reads its configuration from, in its order. */
const NEST_CLI_CONFIG_FILES = ["nest-cli.json", ".nest-cli.json"];

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

/**
 * TS18003, "No inputs were found in config file": expected, since the
 * tsconfig is parsed with a host that lists no files.
 */
const NO_INPUTS_FOUND = 18003;

type NestCliConfig = {
  sourceRoot?: unknown;
  compilerOptions?: {
    tsConfigPath?: unknown;
    builder?: { options?: { configPath?: unknown } };
  };
};

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
 * The compiled file exporting the project's root module, found the way
 * `nest build` lays out its output: `<outDir>/app.module.js`, or
 * `<outDir>/<sourceRoot>/app.module.js` when the TypeScript root directory is
 * the project rather than the source root. Failing both, the one
 * `app.module.js` anywhere under the output directory.
 */
export function detectEntry(projectDir: string, cwd: string): string {
  const nestConfig = readNestCliConfig(projectDir);
  const sourceRoot =
    typeof nestConfig.sourceRoot === "string" ? nestConfig.sourceRoot : "src";
  const outDir =
    readOutDir(projectDir, nestConfig, cwd) ?? join(projectDir, "dist");
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

function readNestCliConfig(projectDir: string): NestCliConfig {
  const configPath = NEST_CLI_CONFIG_FILES.map((file) =>
    join(projectDir, file),
  ).find(isFile);
  if (!configPath) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as NestCliConfig;
  } catch (error) {
    throw new CliError(`Cannot read ${configPath}: ${describeError(error)}`);
  }
}

/**
 * The `outDir` of the tsconfig `nest build` compiles with, following
 * `extends` the way TypeScript does.
 */
function readOutDir(
  projectDir: string,
  nestConfig: NestCliConfig,
  cwd: string,
): string | undefined {
  const configured =
    nestConfig.compilerOptions?.builder?.options?.configPath ??
    nestConfig.compilerOptions?.tsConfigPath;
  const configPath = [configured, "tsconfig.build.json", "tsconfig.json"]
    .filter((path): path is string => typeof path === "string")
    .map((path) => resolve(projectDir, path))
    .find(isFile);
  if (!configPath) {
    return undefined;
  }

  const unreadable = (diagnostics: readonly ts.Diagnostic[]) =>
    new CliError(
      `Cannot read ${displayPath(configPath, cwd)}: ${diagnostics
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        )
        .join("; ")}. Fix it, or pass --entry <file>.`,
    );
  const configFile = ts.readConfigFile(configPath, (path) =>
    ts.sys.readFile(path),
  );
  if (configFile.error) {
    throw unreadable([configFile.error]);
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      // Only outDir is needed, so the source tree is never walked.
      readDirectory: () => [],
      fileExists: (path) => ts.sys.fileExists(path),
      readFile: (path) => ts.sys.readFile(path),
    },
    dirname(configPath),
    undefined,
    configPath,
  );
  const errors = parsed.errors.filter(
    (diagnostic) => diagnostic.code !== NO_INPUTS_FOUND,
  );
  if (errors.length) {
    throw unreadable(errors);
  }

  return parsed.options.outDir;
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

/** A path relative to `cwd` when it lies inside it, else absolute. */
export function displayPath(path: string, cwd: string): string {
  const relativePath = relative(cwd, path);
  const outside =
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);

  return relativePath && !outside ? relativePath : path;
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
