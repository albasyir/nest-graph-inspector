import { readFileSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { ts } from "ts-morph";
import { CliError, CliUsageError, describeError } from "./cli-error";
import { displayPath, isFile } from "./files";

/**
 * `nest-cli.json` and the tsconfig `nest build` compiles with, parsed once,
 * here, into types the rest of the CLI trusts, each setting resolved as the
 * Nest CLI resolves it.
 */

/** In the Nest CLI's order. */
const NEST_CLI_CONFIG_FILES = ["nest-cli.json", ".nest-cli.json"];

export const DEFAULT_SOURCE_ROOT = "src";
const DEFAULT_ENTRY_FILE = "main";
export const DEFAULT_OUT_DIR = "dist";
/** In a monorepo too: `getBuilder` falls back on `tsc`, whatever the project. */
const DEFAULT_BUILDER = "tsc";

/**
 * TS18003, "No inputs were found in config file": expected, since the
 * tsconfig is parsed with a host that lists no files.
 */
const NO_INPUTS_FOUND = 18003;

/** `compilerOptions.builder`: a string, or `{ type, options }`. */
type NestBuilderSetting = {
  type: string | undefined;
  /** The tsconfig for `tsc`; the bundler's own configuration for `webpack` and `rspack`. */
  configPath: string | undefined;
  /** For `swc`, `@swc/cli` options the Nest CLI lets override its own (`swc-defaults.ts`). */
  outDir: string | undefined;
  stripLeadingPaths: boolean | undefined;
  outFileExtension: string | undefined;
};

export type SwcOptions = Pick<NestBuilderSetting, "outDir" | "stripLeadingPaths" | "outFileExtension">;

/**
 * Whose builder options SWC builds `nest build <name>` with (`swc-defaults.ts`):
 * from Nest CLI 12.0.14 the application's, before that the top level's.
 */
type SwcOptionsFrom = "application" | "top-level" | "unknown";

type NestApplicationSettings = {
  root: string | undefined;
  sourceRoot: string | undefined;
  entryFile: string | undefined;
  compilerOptions: {
    tsConfigPath: string | undefined;
    builder: NestBuilderSetting | undefined;
    /** Wins over `builder`; what `nest g app` wrote before `"builder": "rspack"`. */
    webpack: boolean | undefined;
  };
};

type NestProjectSettings = NestApplicationSettings & { type: "application" | "library" };

/** A field of the wrong type is left unset, so the Nest CLI's default stands in for it. */
export type NestCliConfig = NestApplicationSettings & {
  /** Undefined when the project has none. */
  file: string | undefined;
  projects: ReadonlyMap<string, NestProjectSettings>;
  /** See `legacyConventionTsConfigPath`; not the tsconfig `nest build` uses. */
  conventionTsConfigPath: string | undefined;
  swcOptionsFrom: SwcOptionsFrom;
};

export type ApplicationBuild =
  | { kind: "tsc" }
  /** The builder options it could build with — both, when the installed Nest CLI's version is unknown. */
  | { kind: "swc"; options: readonly (SwcOptions | undefined)[] }
  /** A builder the export does not know: its output is looked for as tsc's is. */
  | { kind: "other"; builder: string }
  /** One `main.js` holding the application and every module it imports, which starts it as it loads. */
  | { kind: "bundled"; bundler: "webpack" | "rspack" };

export type NestApplication = {
  /** Undefined for a default project no project matches. */
  name: string | undefined;
  /** Relative to the project directory; `""` when unset. */
  root: string;
  sourceRoot: string;
  entryFile: string;
  /** Tried before `tsconfig.build.json` and `tsconfig.json`. */
  tsConfigPath: string | undefined;
  build: ApplicationBuild;
};

export type ApplicationSelection =
  | {
      kind: "selected";
      application: NestApplication;
      /** Said on stderr when the default project was taken among other applications. */
      note: string | undefined;
    }
  | { kind: "no-default-project"; applications: readonly string[] }
  | { kind: "unknown-application"; requested: string; applications: readonly string[] }
  | { kind: "library"; requested: string; applications: readonly string[] }
  | { kind: "no-projects"; requested: string };

type BuildTsConfig = {
  path: string;
  /** Path options — `outDir`, `rootDir` — are absolute. */
  options: ts.CompilerOptions;
};

export type ApplicationLayout = {
  projectDir: string;
  application: NestApplication;
  tsconfig: BuildTsConfig | undefined;
};

export function readNestCliConfig(projectDir: string): NestCliConfig {
  const swcOptionsFrom = installedSwcOptionsFrom(projectDir);
  const file = NEST_CLI_CONFIG_FILES.map((name) => join(projectDir, name)).find(isFile);
  if (!file) {
    return parseNestCliConfig(undefined, undefined, swcOptionsFrom);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(`Cannot read ${file}: ${describeError(error)}`);
  }

  return parseNestCliConfig(raw, file, swcOptionsFrom);
}

export function readNestCliConfigOrDefaults(projectDir: string): NestCliConfig {
  try {
    return readNestCliConfig(projectDir);
  } catch (error) {
    if (error instanceof CliError) {
      return parseNestCliConfig(undefined, undefined, installedSwcOptionsFrom(projectDir));
    }

    throw error;
  }
}

function parseNestCliConfig(
  raw: unknown,
  file: string | undefined,
  swcOptionsFrom: SwcOptionsFrom,
): NestCliConfig {
  const config = isRecord(raw) ? raw : {};

  return {
    file,
    ...parseApplicationSettings(config),
    projects: parseProjects(config.projects),
    conventionTsConfigPath: legacyConventionTsConfigPath(config),
    swcOptionsFrom,
  };
}

/** By the version of the Nest CLI the project's scripts run, read from its package.json as Node finds it, never run. */
function installedSwcOptionsFrom(projectDir: string): SwcOptionsFrom {
  for (let dir = projectDir; ; dir = dirname(dir)) {
    const manifest = join(dir, "node_modules", "@nestjs", "cli", "package.json");
    if (isFile(manifest)) {
      let version: unknown;
      try {
        version = (JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown }).version;
      } catch {
        return "unknown";
      }

      const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
      if (!parts) {
        return "unknown";
      }

      const [major, minor, patch] = parts.slice(1).map(Number);
      return (major * 1000 + minor) * 1000 + patch >= 12_000_014 ? "application" : "top-level";
    }

    if (dirname(dir) === dir) {
      return "unknown";
    }
  }
}

/**
 * The tsconfig the `app.module.js` convention reads, chosen as it always has
 * been, from the raw nest-cli.json: the builder's `options.configPath` —
 * whatever the builder — else `compilerOptions.tsConfigPath`; a value that is
 * not a string set aside only after that choice. Unchanged on purpose: a
 * project the convention finds an entry for keeps finding that same entry.
 */
function legacyConventionTsConfigPath(config: Readonly<Record<string, unknown>>): string | undefined {
  const compilerOptions = isRecord(config.compilerOptions) ? config.compilerOptions : {};
  const builder = isRecord(compilerOptions.builder) ? compilerOptions.builder : {};
  const options = isRecord(builder.options) ? builder.options : {};
  const chosen = options.configPath ?? compilerOptions.tsConfigPath;
  return typeof chosen === "string" ? chosen : undefined;
}

function parseApplicationSettings(settings: Readonly<Record<string, unknown>>): NestApplicationSettings {
  const options = isRecord(settings.compilerOptions) ? settings.compilerOptions : {};
  return {
    root: stringField(settings, "root"),
    sourceRoot: stringField(settings, "sourceRoot"),
    entryFile: stringField(settings, "entryFile"),
    compilerOptions: {
      tsConfigPath: stringField(options, "tsConfigPath"),
      builder: parseBuilder(options.builder),
      webpack: typeof options.webpack === "boolean" ? options.webpack : undefined,
    },
  };
}

function parseBuilder(value: unknown): NestBuilderSetting | undefined {
  if (typeof value === "string") {
    return {
      type: value,
      configPath: undefined,
      outDir: undefined,
      stripLeadingPaths: undefined,
      outFileExtension: undefined,
    };
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const options = isRecord(value.options) ? value.options : {};
  return {
    type: stringField(value, "type"),
    configPath: stringField(options, "configPath"),
    outDir: stringField(options, "outDir"),
    stripLeadingPaths:
      typeof options.stripLeadingPaths === "boolean" ? options.stripLeadingPaths : undefined,
    outFileExtension: stringField(options, "outFileExtension"),
  };
}

function parseProjects(value: unknown): ReadonlyMap<string, NestProjectSettings> {
  const projects = new Map<string, NestProjectSettings>();
  if (!isRecord(value)) {
    return projects;
  }

  for (const [name, project] of Object.entries(value)) {
    if (isRecord(project)) {
      projects.set(name, {
        type: project.type === "library" ? "library" : "application",
        ...parseApplicationSettings(project),
      });
    }
  }

  return projects;
}

/**
 * The application `--app` names, or the default project: the top level of
 * nest-cli.json, which is what `nest build` builds when it is given no name.
 */
export function selectApplication(
  config: NestCliConfig,
  requested: string | undefined,
): ApplicationSelection {
  const applications = applicationNames(config);

  if (requested !== undefined) {
    if (config.projects.size === 0) {
      return { kind: "no-projects", requested };
    }

    const project = config.projects.get(requested);
    if (!project) {
      return { kind: "unknown-application", requested, applications };
    }

    if (project.type === "library") {
      return { kind: "library", requested, applications };
    }

    // `nest build <name>`: the project's own setting, else the top level's.
    return {
      kind: "selected",
      application: resolveApplication(requested, project, config),
      note: undefined,
    };
  }

  if (!applications.length) {
    return {
      kind: "selected",
      application: resolveApplication(undefined, config, config),
      note: undefined,
    };
  }

  // Among named applications, only a top level that says where its sources
  // are is a default project; `nest build` without a name builds it.
  if (config.sourceRoot === undefined && config.root === undefined) {
    return { kind: "no-default-project", applications };
  }

  const match = matchDefaultProject(config);
  const others = applications.filter((name) => name !== match?.name);
  const defaultName = match?.name ?? `(sourceRoot ${config.sourceRoot ?? DEFAULT_SOURCE_ROOT})`;

  return {
    kind: "selected",
    // The top level alone, as `nest build` without a name reads it: the
    // project it matches only names it. That project's own settings apply
    // when --app selects it.
    application: resolveApplication(match?.name, config, config),
    note: others.length
      ? `${configFileName(config)} defines applications ${applications.join(", ")}; using the default project ${defaultName} (pass --app <name> for another)`
      : undefined,
  };
}

/** Among named applications, for a file the convention found that is not plainly the default project's own output. */
export function conventionEntryNote(config: NestCliConfig, entry: string): string {
  return `${configFileName(config)} defines applications ${applicationNames(config).join(", ")}; using ${entry}, found by convention (pass --app <name> for another)`;
}

function everyApplication(config: NestCliConfig): NestApplication[] {
  return [
    resolveApplication(undefined, config, config),
    ...applicationNames(config).flatMap((name) => {
      const project = config.projects.get(name);
      return project ? [resolveApplication(name, project, config)] : [];
    }),
  ];
}

/** A usage error when `--app` named nothing usable. */
export function applicationSelectionError(
  selection: Exclude<ApplicationSelection, { kind: "selected" }>,
  config: NestCliConfig,
): CliError {
  const file = configFileName(config);
  const choose = (applications: readonly string[]) =>
    applications.length
      ? `Pass --app with one of: ${applications.join(", ")}.`
      : `${file} defines no application; run the export without --app.`;

  switch (selection.kind) {
    case "no-default-project": {
      const { applications } = selection;
      return new CliError(
        `${file} defines ${applications.length} application${applications.length === 1 ? "" : "s"} (${applications.join(", ")}) and no default project. Pass --app <name>.`,
      );
    }
    case "unknown-application":
      return new CliUsageError(
        `${file} has no project "${selection.requested}". ${choose(selection.applications)}`,
      );
    case "library":
      return new CliUsageError(
        `"${selection.requested}" is a library, which has no main.ts. ${choose(selection.applications)}`,
      );
    case "no-projects":
      return new CliUsageError(
        config.file
          ? `${file} defines no projects, so --app ${selection.requested} has nothing to choose from. Run the export without --app.`
          : `The project has no nest-cli.json, so --app ${selection.requested} has nothing to choose from. Run the export without --app.`,
      );
    default: {
      const _exhaustive: never = selection;
      return _exhaustive;
    }
  }
}

/**
 * Each setting as the Nest CLI's `getValueOrDefault` resolves it: `primary`'s,
 * else the top level's, else the default — an `swc` builder's options as the
 * installed Nest CLI takes them.
 */
function resolveApplication(
  name: string | undefined,
  primary: NestApplicationSettings,
  config: NestCliConfig,
): NestApplication {
  const builder = primary.compilerOptions.builder ?? config.compilerOptions.builder;
  const webpack = primary.compilerOptions.webpack ?? config.compilerOptions.webpack;
  const tsConfigPath =
    primary.compilerOptions.tsConfigPath ?? config.compilerOptions.tsConfigPath;
  const topLevel = config.compilerOptions.builder;

  return {
    name,
    root: primary.root ?? config.root ?? "",
    sourceRoot: primary.sourceRoot ?? config.sourceRoot ?? DEFAULT_SOURCE_ROOT,
    entryFile: primary.entryFile ?? config.entryFile ?? DEFAULT_ENTRY_FILE,
    // As `nest build` finds it (getTscConfigPath): `tsConfigPath` first; a
    // builder's `options.configPath` only after, and only a `tsc` builder's.
    tsConfigPath: tsConfigPath ?? (builder?.type === "tsc" ? builder.configPath : undefined),
    build: buildOf(
      builder,
      webpack,
      { application: [builder], "top-level": [topLevel], unknown: [builder, topLevel] }[config.swcOptionsFrom],
    ),
  };
}

/**
 * As the Nest CLI decides it (`build.action.ts`, `getBuilder`):
 * `compilerOptions.webpack: true` is a webpack build, whatever the builder;
 * otherwise the builder decides, `tsc` when nest-cli.json names none — in a
 * monorepo as anywhere else. `nest g app` writes `"builder": "rspack"` when it
 * makes a monorepo, and older Nest CLIs wrote `"webpack": true`: that is what
 * makes a monorepo a bundle.
 */
function buildOf(
  builder: NestBuilderSetting | undefined,
  webpack: boolean | undefined,
  swcOptions: readonly (SwcOptions | undefined)[],
): ApplicationBuild {
  if (webpack === true) {
    return { kind: "bundled", bundler: "webpack" };
  }

  const type = builder?.type ?? DEFAULT_BUILDER;
  switch (type) {
    case "webpack":
    case "rspack":
      return { kind: "bundled", bundler: type };
    case "tsc":
      return { kind: "tsc" };
    case "swc":
      return { kind: "swc", options: swcOptions };
    default:
      return { kind: "other", builder: type };
  }
}

/** Matched by `sourceRoot`, else by `root`. */
function matchDefaultProject(
  config: NestCliConfig,
): { name: string; project: NestProjectSettings } | undefined {
  const projects = [...config.projects]
    .filter(([, project]) => project.type === "application")
    .map(([name, project]) => ({ name, project }));
  const normalized = (path: string) => normalize(path).replace(/[\\/]+$/, "");
  const same = (left: string | undefined, right: string | undefined) =>
    left !== undefined && right !== undefined && normalized(left) === normalized(right);

  return (
    projects.find(({ project }) => same(project.sourceRoot, config.sourceRoot)) ??
    projects.find(({ project }) => same(project.root, config.root))
  );
}

function applicationNames(config: NestCliConfig): string[] {
  return [...config.projects]
    .filter(([, project]) => project.type === "application")
    .map(([name]) => name);
}

function configFileName(config: NestCliConfig): string {
  return config.file ? basename(config.file) : NEST_CLI_CONFIG_FILES[0];
}

/**
 * `configured`, else `tsconfig.build.json`, else `tsconfig.json`, the first
 * that exists, parsed the way tsc reads it, `extends` followed.
 */
export function readBuildTsConfig(
  projectDir: string,
  configured: string | undefined,
  cwd: string,
): BuildTsConfig | undefined {
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
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
        .join("; ")}. Fix it, or pass --entry <file>.`,
    );
  const configFile = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (configFile.error) {
    throw unreadable([configFile.error]);
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      // Only compiler options are needed, so the source tree is never walked.
      readDirectory: () => [],
      fileExists: (path) => ts.sys.fileExists(path),
      readFile: (path) => ts.sys.readFile(path),
    },
    dirname(configPath),
    undefined,
    configPath,
  );
  const errors = parsed.errors.filter((diagnostic) => diagnostic.code !== NO_INPUTS_FOUND);
  if (errors.length) {
    throw unreadable(errors);
  }

  return { path: configPath, options: parsed.options };
}

export function readApplicationLayout(
  projectDir: string,
  application: NestApplication,
  cwd: string,
): ApplicationLayout {
  return {
    projectDir,
    application,
    tsconfig: readBuildTsConfig(projectDir, application.tsConfigPath, cwd),
  };
}

/** Every application; one whose tsconfig cannot be read is taken to build into `dist/`, never a reason to fail. */
export function readEveryLayout(
  projectDir: string,
  config: NestCliConfig,
  cwd: string,
): ApplicationLayout[] {
  return everyApplication(config).map((application) => {
    try {
      return readApplicationLayout(projectDir, application, cwd);
    } catch (error) {
      if (!(error instanceof CliError)) {
        throw error;
      }

      return { projectDir, application, tsconfig: undefined };
    }
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
