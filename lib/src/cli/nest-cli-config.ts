import { readFileSync } from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import { ts } from "ts-morph";
import { CliError, CliUsageError, describeError } from "./cli-error";
import { displayPath, isFile } from "./files";

/**
 * What the export reads from a Nest project's configuration files —
 * `nest-cli.json` and the tsconfig `nest build` compiles with — parsed once,
 * here, into types the rest of the CLI trusts. Nothing in this file loads or
 * runs anything: it reads files and parses them.
 */

/** The files the Nest CLI reads its configuration from, in its order. */
const NEST_CLI_CONFIG_FILES = ["nest-cli.json", ".nest-cli.json"];

/** The Nest CLI's defaults for a `nest-cli.json` that leaves them unset. */
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

/** `compilerOptions.builder`: a string, or `{ type, options: { configPath } }`. */
export type NestBuilderSetting = {
  /** `tsc`, `swc`, `webpack`, `rspack`; unset when only `options` is given. */
  type: string | undefined;
  /**
   * `options.configPath`: the tsconfig for `tsc`, the bundler's own
   * configuration for `webpack` and `rspack`.
   */
  configPath: string | undefined;
};

/** The `compilerOptions` that decide where and how an application is built. */
export type NestCompilerSettings = {
  tsConfigPath: string | undefined;
  builder: NestBuilderSetting | undefined;
  /**
   * The older switch for a webpack build, which wins over `builder`; what
   * `nest g app` wrote before it wrote `"builder": "rspack"`.
   */
  webpack: boolean | undefined;
};

/** Where an application lives and how it is built, as one level of nest-cli.json states it. */
type NestApplicationSettings = {
  root: string | undefined;
  sourceRoot: string | undefined;
  entryFile: string | undefined;
  compilerOptions: NestCompilerSettings;
};

/** One entry of `projects`. */
export type NestProjectSettings = NestApplicationSettings & {
  /** `library` for a library; anything else — usually `application` — is an application. */
  type: "application" | "library";
};

/**
 * `nest-cli.json`, validated: a field of the wrong type is ignored, as if it
 * were unset, so the Nest CLI's default stands in for it.
 */
export type NestCliConfig = NestApplicationSettings & {
  /** The file it was read from; undefined when the project has none. */
  file: string | undefined;
  projects: ReadonlyMap<string, NestProjectSettings>;
  /**
   * The tsconfig the `app.module.js` convention reads, chosen exactly as it
   * always has been — see `legacyConventionTsConfigPath`; not the one
   * `nest build` uses, which an application's `tsConfigPath` is.
   */
  conventionTsConfigPath: string | undefined;
};

/** How `nest build` turns an application's sources into JavaScript. */
export type ApplicationBuild =
  /** `tsc` or `swc`: a JavaScript file per source file, under the outDir. */
  | { kind: "compiled"; compiler: string }
  /**
   * `webpack` or `rspack`: the application and every module it imports in one
   * `main.js`, which starts the application when it is loaded.
   */
  | { kind: "bundled"; bundler: "webpack" | "rspack" };

/** An application `nest build` builds, each setting resolved as the Nest CLI resolves it. */
export type NestApplication = {
  /** Its name under `projects`; undefined for a default project no project matches. */
  name: string | undefined;
  /** Relative to the project directory, as written; `""` when unset. */
  root: string;
  sourceRoot: string;
  entryFile: string;
  /** The tsconfig nest-cli.json names for it, tried before `tsconfig.build.json` and `tsconfig.json`. */
  tsConfigPath: string | undefined;
  build: ApplicationBuild;
};

/** Which application an export is of, or why there is none. */
export type ApplicationSelection =
  | {
      kind: "selected";
      application: NestApplication;
      /** Said on stderr when the default project was taken among other applications. */
      note: string | undefined;
    }
  /** A monorepo without `--app`, whose top level names no default project. */
  | { kind: "no-default-project"; applications: readonly string[] }
  | { kind: "unknown-application"; requested: string; applications: readonly string[] }
  | { kind: "library"; requested: string; applications: readonly string[] }
  /** `--app` for a project whose nest-cli.json defines no `projects`. */
  | { kind: "no-projects"; requested: string };

/** The tsconfig `nest build` compiles an application with, parsed. */
export type BuildTsConfig = {
  path: string;
  /** Path options — `outDir`, `rootDir` — are absolute. */
  options: ts.CompilerOptions;
};

/** An application, with the tsconfig `nest build` compiles it with. */
export type ApplicationLayout = {
  projectDir: string;
  application: NestApplication;
  tsconfig: BuildTsConfig | undefined;
};

/** Reads the project's `nest-cli.json` (or `.nest-cli.json`); every setting unset when there is none. */
export function readNestCliConfig(projectDir: string): NestCliConfig {
  const file = NEST_CLI_CONFIG_FILES.map((name) => join(projectDir, name)).find(
    isFile,
  );
  if (!file) {
    return parseNestCliConfig(undefined, undefined);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(`Cannot read ${file}: ${describeError(error)}`);
  }

  return parseNestCliConfig(raw, file);
}

/**
 * `nest-cli.json` as far as it can be read: every setting unset when it
 * cannot be. For an export that does not otherwise need the file — one given
 * `--entry` — which a broken `nest-cli.json` must not fail.
 */
export function readNestCliConfigOrDefaults(projectDir: string): NestCliConfig {
  try {
    return readNestCliConfig(projectDir);
  } catch (error) {
    if (error instanceof CliError) {
      return parseNestCliConfig(undefined, undefined);
    }

    throw error;
  }
}

/** Validates parsed `nest-cli.json` content: what is not of the expected type is left unset. */
export function parseNestCliConfig(
  raw: unknown,
  file: string | undefined,
): NestCliConfig {
  const config = isRecord(raw) ? raw : {};

  return {
    file,
    ...parseApplicationSettings(config),
    projects: parseProjects(config.projects),
    conventionTsConfigPath: legacyConventionTsConfigPath(config),
  };
}

/**
 * The tsconfig the `app.module.js` convention reads, chosen as it always has
 * been, from the raw nest-cli.json: the builder's `options.configPath` —
 * whatever the builder — else `compilerOptions.tsConfigPath`; a value that is
 * not a string set aside only after that choice. Unchanged on purpose: a
 * project the convention finds an entry for keeps finding that same entry.
 */
function legacyConventionTsConfigPath(
  config: Readonly<Record<string, unknown>>,
): string | undefined {
  const compilerOptions = isRecord(config.compilerOptions) ? config.compilerOptions : {};
  const builder = isRecord(compilerOptions.builder) ? compilerOptions.builder : {};
  const options = isRecord(builder.options) ? builder.options : {};
  const chosen = options.configPath ?? compilerOptions.tsConfigPath;
  return typeof chosen === "string" ? chosen : undefined;
}

function parseApplicationSettings(
  settings: Readonly<Record<string, unknown>>,
): NestApplicationSettings {
  return {
    root: stringField(settings, "root"),
    sourceRoot: stringField(settings, "sourceRoot"),
    entryFile: stringField(settings, "entryFile"),
    compilerOptions: parseCompilerSettings(settings.compilerOptions),
  };
}

function parseCompilerSettings(value: unknown): NestCompilerSettings {
  const options = isRecord(value) ? value : {};
  const webpack = options.webpack;

  return {
    tsConfigPath: stringField(options, "tsConfigPath"),
    builder: parseBuilder(options.builder),
    webpack: typeof webpack === "boolean" ? webpack : undefined,
  };
}

function parseBuilder(value: unknown): NestBuilderSetting | undefined {
  if (typeof value === "string") {
    return { type: value, configPath: undefined };
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const options = isRecord(value.options) ? value.options : {};
  return {
    type: stringField(value, "type"),
    configPath: stringField(options, "configPath"),
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
 * The application an export is of: the one `--app` names, or the project's
 * default — the top level of nest-cli.json, which is what `nest build` builds
 * when it is given no name.
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
      application: resolveApplication(undefined, config, undefined),
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
    application: resolveApplication(match?.name, config, undefined),
    note: others.length
      ? `${configFileName(config)} defines applications ${applications.join(", ")}; using the default project ${defaultName} (pass --app <name> for another)`
      : undefined,
  };
}

/**
 * The note an entry found by convention gets, among named applications, when
 * the file is not plainly the default project's own output: the file it is,
 * and how to choose an application instead.
 */
export function conventionEntryNote(config: NestCliConfig, entry: string): string {
  return `${configFileName(config)} defines applications ${applicationNames(config).join(", ")}; using ${entry}, found by convention (pass --app <name> for another)`;
}

/**
 * The default project and every named application: each application whose
 * entry file the export refuses to load, for an entry it did not find itself.
 */
function everyApplication(config: NestCliConfig): NestApplication[] {
  return [
    resolveApplication(undefined, config, undefined),
    ...applicationNames(config).flatMap((name) => {
      const project = config.projects.get(name);
      return project ? [resolveApplication(name, project, config)] : [];
    }),
  ];
}

/** The error a failed selection is reported with: a usage error when `--app` named nothing usable. */
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
    case "no-default-project":
      return new CliError(
        `${file} defines ${plural(selection.applications.length, "application")} (${selection.applications.join(", ")}) and no default project. Pass --app <name>.`,
      );
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
 * Each setting as the Nest CLI's `getValueOrDefault` resolves it: `primary`'s
 * value, else `fallback`'s, else the CLI's default.
 */
function resolveApplication(
  name: string | undefined,
  primary: NestApplicationSettings,
  fallback: NestApplicationSettings | undefined,
): NestApplication {
  const builder =
    primary.compilerOptions.builder ?? fallback?.compilerOptions.builder;
  const webpack =
    primary.compilerOptions.webpack ?? fallback?.compilerOptions.webpack;
  const tsConfigPath =
    primary.compilerOptions.tsConfigPath ??
    fallback?.compilerOptions.tsConfigPath;

  return {
    name,
    root: primary.root ?? fallback?.root ?? "",
    sourceRoot:
      primary.sourceRoot ?? fallback?.sourceRoot ?? DEFAULT_SOURCE_ROOT,
    entryFile: primary.entryFile ?? fallback?.entryFile ?? DEFAULT_ENTRY_FILE,
    // As `nest build` finds it (getTscConfigPath): `tsConfigPath` first; a
    // builder's `options.configPath` only after, and only a `tsc` builder's.
    tsConfigPath:
      tsConfigPath ?? (builder?.type === "tsc" ? builder.configPath : undefined),
    build: buildOf(builder, webpack),
  };
}

/**
 * How `nest build` builds an application, decided as the Nest CLI decides it
 * (`build.action.ts`, `getBuilder`): `compilerOptions.webpack: true` is a
 * webpack build, whatever the builder; otherwise the builder decides, `tsc`
 * when nest-cli.json names none — in a monorepo as anywhere else. A `webpack`
 * or `rspack` builder bundles; `tsc`, `swc` and any other compile. `nest g
 * app` writes `"builder": "rspack"` when it makes a monorepo, and older Nest
 * CLIs wrote `"webpack": true`: that is what makes a monorepo a bundle.
 */
function buildOf(
  builder: NestBuilderSetting | undefined,
  webpack: boolean | undefined,
): ApplicationBuild {
  if (webpack === true) {
    return { kind: "bundled", bundler: "webpack" };
  }

  const type = builder?.type ?? DEFAULT_BUILDER;
  return type === "webpack" || type === "rspack"
    ? { kind: "bundled", bundler: type }
    : { kind: "compiled", compiler: type };
}

/** The application project the top level describes, matched by `sourceRoot`, else by `root`. */
function matchDefaultProject(
  config: NestCliConfig,
): { name: string; project: NestProjectSettings } | undefined {
  const projects = [...config.projects]
    .filter(([, project]) => project.type === "application")
    .map(([name, project]) => ({ name, project }));
  const same = (left: string | undefined, right: string | undefined) =>
    left !== undefined && right !== undefined && samePath(left, right);

  return (
    projects.find(({ project }) => same(project.sourceRoot, config.sourceRoot)) ??
    projects.find(({ project }) => same(project.root, config.root))
  );
}

function samePath(left: string, right: string): boolean {
  const normalized = (path: string) => normalize(path).replace(/[\\/]+$/, "");
  return normalized(left) === normalized(right);
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
 * The tsconfig `nest build` compiles with — `configured`, else
 * `tsconfig.build.json`, else `tsconfig.json`, the first that exists — parsed
 * the way tsc reads it, following `extends`. Undefined when there is none.
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
      // Only compiler options are needed, so the source tree is never walked.
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

  return { path: configPath, options: parsed.options };
}

/**
 * An application with the tsconfig it is built with, as `nest build <name>`
 * finds it; throws when that tsconfig cannot be read.
 */
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

/**
 * The default project and every named application, each with the tsconfig it
 * is built with as far as that can be read: an application whose tsconfig
 * cannot be read is taken to build into `dist/`, never a reason to fail.
 */
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

/**
 * The tsconfig the entry-file convention reads, chosen as it always has been
 * (`conventionTsConfigPath`), so a project the convention finds an entry for
 * finds that same entry.
 */
export function readConventionTsConfig(
  projectDir: string,
  config: NestCliConfig,
  cwd: string,
): BuildTsConfig | undefined {
  return readBuildTsConfig(projectDir, config.conventionTsConfigPath, cwd);
}

/** Where `nest build` writes an application: its tsconfig's outDir, else `dist`. */
export function outDirOf(
  projectDir: string,
  tsconfig: BuildTsConfig | undefined,
): string {
  return tsconfig?.options.outDir ?? join(projectDir, DEFAULT_OUT_DIR);
}

/** An object parsed from JSON, whose fields are still to be checked one by one. */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
