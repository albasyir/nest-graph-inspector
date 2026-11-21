import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { ts } from "ts-morph";
import { CliError, describeError } from "./cli-error";
import { displayPath, isFile, pathInside } from "./files";
import {
  DEFAULT_OUT_DIR,
  outDirOf,
  readEveryLayout,
  type ApplicationBuild,
  type ApplicationLayout,
  type NestApplication,
  type NestCliConfig,
} from "./nest-cli-config";

/**
 * Finds an application's root module without running any of it: main.ts is
 * parsed rather than loaded, and the module it passes to `NestFactory` is traced
 * through its import to a source file, then to the file `nest build` compiled
 * it to. The file the export is about to load is checked here first, too, so
 * that it is never main.ts itself, compiled or bundled, or any other file that
 * calls `NestFactory`. Only that one file is checked: the modules it imports
 * load with it, unread, so a root module file must not import main.ts or a
 * bootstrap file. This file only reads and parses files.
 */

/** The `NestFactory` methods that boot an application from its root module. */
const BOOT_METHODS = new Set([
  "create",
  "createApplicationContext",
  "createMicroservice",
]);

const NEST_FACTORY = "NestFactory";

/** The package Nest's own `NestFactory` comes from. */
const NEST_CORE = "@nestjs/core";

/** The extensions an application's entry file is looked for with, in this order. */
const ENTRY_FILE_EXTENSIONS = [
  ".ts",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
] as const;

/** What each source extension compiles to. */
const COMPILED_EXTENSIONS = new Map([
  [".ts", ".js"],
  [".tsx", ".js"],
  [".mts", ".mjs"],
  [".cts", ".cjs"],
  [".js", ".js"],
  [".jsx", ".js"],
  [".mjs", ".mjs"],
  [".cjs", ".cjs"],
]);

/** Resolved files that hold no code the export could load. */
const UNLOADABLE_EXTENSIONS = new Set<string>([
  ts.Extension.Dts,
  ts.Extension.Dmts,
  ts.Extension.Dcts,
  ts.Extension.Json,
]);

/** How many `const` declarations a root module argument is followed through. */
const MAX_CONSTANT_DEPTH = 3;

/**
 * How many files of re-exports — `export { X } from`, `export * from` — the
 * convention check follows from main.ts's import to the class it names.
 */
const MAX_REEXPORT_DEPTH = 3;

type NonEmptyArray<T> = readonly [T, ...T[]];

function isNonEmpty<T>(items: readonly T[]): items is NonEmptyArray<T> {
  return items.length > 0;
}

/** The project a file is about to be loaded from. */
export type LoadingProject = {
  projectDir: string;
  cwd: string;
  /** Every application nest-cli.json defines has its entry files refused. */
  config: NestCliConfig;
};

/** A root module main.ts boots, as main.ts names it. */
export type BootedRootModule = {
  /** The name its file exports it under; `default` for a default export. */
  exportName: string;
  /** What main.ts calls it: the imported name, or `mods.RootModule`. */
  localName: string;
  /** The file main.ts imports it from, resolved as TypeScript resolves the import. */
  sourceFile: string;
  /** For `RootModule.forRoot(...)`: `forRoot`. */
  dynamicMethod: string | undefined;
};

export type MainFileAnalysis =
  /** The root modules main.ts boots, each once, in the order it boots them. */
  | { kind: "boots"; mainFile: string; roots: NonEmptyArray<BootedRootModule> }
  /** main.ts declares its root module class itself: loading it would start the application. */
  | { kind: "declares-root"; mainFile: string; name: string }
  /** Nothing to act on: no main.ts, no `NestFactory` call, or a root module only known at runtime. */
  | { kind: "unknown"; reason: string };

export type RootModuleChoice =
  | { kind: "chosen"; root: BootedRootModule; moduleName: string }
  | { kind: "ambiguous"; message: string };

/** Where the export can load a root module from, or why it cannot. */
export type RootModuleEntry =
  | { kind: "compiled"; path: string }
  /** The TypeScript source, for a `--require` loader. */
  | { kind: "source"; path: string }
  | { kind: "not-built"; candidates: readonly string[] }
  /** Built into a bundle, of which nothing but the entry exists to load. */
  | { kind: "bundled"; bundler: Bundler }
  /**
   * Built by SWC both where Nest CLI 12 writes it and where Nest CLI 11 does:
   * one of the two is left from an older build, and which cannot be told.
   */
  | { kind: "both-layouts"; paths: readonly string[] }
  /**
   * Built to a file another application's build writes too, from a source at
   * the same path in its own tree: whose the file is cannot be told.
   */
  | { kind: "shared"; path: string; otherSource: string };

/** What exists of a file's compiled candidates. */
export type CompiledFile =
  | { kind: "found"; path: string }
  /** SWC's two layouts, both there: see `RootModuleEntry`. */
  | { kind: "both-layouts"; paths: readonly string[] }
  | { kind: "missing" };

type Bundler = Extract<ApplicationBuild, { kind: "bundled" }>["bundler"];

/** What main.ts boots, kept to check the export's own choice against once it is made. */
export type ConventionCheck = {
  mainFile: string;
  root: BootedRootModule;
  /** Where `nest build` writes the root module's file. */
  compiled: readonly string[];
};

/** main.ts, bound: the checker finds the declaration each name in it refers to. */
type BoundMainFile = { sourceFile: ts.SourceFile; checker: ts.TypeChecker };

type RootArgument =
  | {
      kind: "imported";
      specifier: string;
      exportName: string;
      localName: string;
      dynamicMethod: string | undefined;
    }
  | { kind: "declared"; name: string }
  | { kind: "unknown" };

/** A call made through `NestFactory`, and whether the method is called directly. */
type NestFactoryCall = {
  /** `create`; undefined for a computed `NestFactory[name]`. */
  method: string | undefined;
  /** `NestFactory.create(...)`, as opposed to `NestFactory.create.call(...)`. */
  direct: boolean;
};

/**
 * Parses the application's entry file — `<sourceRoot>/<entryFile>.ts`, or
 * `.mts`, `.cts`, `.js`, `.mjs`, `.cjs` — and traces the root module each
 * `NestFactory.create`, `createApplicationContext` or `createMicroservice`
 * call boots to the file that declares it. The file is parsed rather than loaded.
 */
export function analyseMainFile(layout: ApplicationLayout): MainFileAnalysis {
  const { application } = layout;
  const mainFile = entryFileSources(layout).find(isFile);
  if (!mainFile) {
    return {
      kind: "unknown",
      reason: `no ${application.entryFile} file in ${application.sourceRoot}`,
    };
  }

  let text: string;
  try {
    text = readFileSync(mainFile, "utf8");
  } catch (error) {
    return { kind: "unknown", reason: describeError(error) };
  }

  const main = parseWithScopes(mainFile, text);
  const calls = findBootCalls(main);
  if (!calls.length) {
    return { kind: "unknown", reason: "it calls no NestFactory method" };
  }

  let roots: readonly BootedRootModule[] = [];
  for (const argument of calls) {
    const root =
      argument === undefined ? undefined : analyseRootArgument(argument, main, 0);
    if (root?.kind === "declared") {
      return { kind: "declares-root", mainFile, name: root.name };
    }

    // A root module only known at runtime is passed over: what can be
    // followed decides.
    if (root?.kind !== "imported") {
      continue;
    }

    const sourceFile = resolveImport(root.specifier, mainFile, layout);
    if (sourceFile !== undefined) {
      roots = withRoot(roots, {
        exportName: root.exportName,
        localName: root.localName,
        sourceFile,
        dynamicMethod: root.dynamicMethod,
      });
    }
  }

  return isNonEmpty(roots)
    ? { kind: "boots", mainFile, roots }
    : {
        kind: "unknown",
        reason: "its root module is not an import the export can follow",
      };
}

/** Each root module once, by file and export; a `.forRoot()` call on any boot of it marks it. */
function withRoot(
  roots: readonly BootedRootModule[],
  root: BootedRootModule,
): readonly BootedRootModule[] {
  const known = roots.find(
    (candidate) =>
      candidate.sourceFile === root.sourceFile &&
      candidate.exportName === root.exportName,
  );
  if (!known) {
    return [...roots, root];
  }

  return roots.map((candidate) =>
    candidate === known && candidate.dynamicMethod === undefined
      ? { ...candidate, dynamicMethod: root.dynamicMethod }
      : candidate,
  );
}

/**
 * The root module to export: the only one main.ts boots, or the one `--module`
 * names — by the name its file exports it under, else by the name main.ts
 * imports it as. A name that matches several root modules — one export name
 * from two files — chooses none. `--module` naming another export of the only
 * root's file exports that.
 */
export function chooseRootModule(
  analysis: Extract<MainFileAnalysis, { kind: "boots" }>,
  requestedModule: string | undefined,
  cwd: string,
): RootModuleChoice {
  const { roots } = analysis;
  const main = displayPath(analysis.mainFile, cwd);
  const listed = (candidates: readonly BootedRootModule[]) => {
    const names = candidates.map(rootName);
    return new Set(names).size === names.length
      ? names
      : candidates.map(
          (root) => `${rootName(root)} from ${displayPath(root.sourceFile, cwd)}`,
        );
  };

  if (requestedModule !== undefined) {
    const byExport = roots.filter((root) => root.exportName === requestedModule);
    const matches = byExport.length
      ? byExport
      : roots.filter((root) => root.localName === requestedModule);
    const [match, ...others] = matches;
    if (match !== undefined && !others.length) {
      return { kind: "chosen", root: match, moduleName: match.exportName };
    }

    if (match !== undefined) {
      return {
        kind: "ambiguous",
        message: `${main} boots ${matches.length} root modules named ${requestedModule} (${listed(matches).join(", ")}). Pass --entry <file> and --module ${requestedModule} for the one to export.`,
      };
    }

    if (roots.length === 1) {
      return { kind: "chosen", root: roots[0], moduleName: requestedModule };
    }
  } else if (roots.length === 1) {
    return { kind: "chosen", root: roots[0], moduleName: roots[0].exportName };
  }

  const plainNames = roots.map(rootName);
  const distinct = new Set(plainNames).size === plainNames.length;
  const boots = `${main} boots ${roots.length} root modules (${listed(roots).join(", ")})`;

  return {
    kind: "ambiguous",
    message:
      requestedModule === undefined
        ? `${boots}. ${distinct ? "Pass --module <name>." : "Pass --entry <file> and --module <name>."}`
        : `${boots}, and none of them is ${requestedModule}. Pass --module with one of them, or --entry <file> and --module <name>.`,
  };
}

/**
 * The file to load for a root module. A compiled application loads the file
 * `nest build` compiled the module's source to, found by probing — when that
 * file is plainly this build's. A bundled one has no such file — its
 * `main.js` holds everything and starts the application — so, like an
 * application not built yet, or one whose compiled file cannot be told
 * current or its own, it is loaded from its TypeScript source when
 * `--require` names a loader, and not at all otherwise. `others` are the
 * project's other applications, whose builds could write the same file.
 */
export function locateRootModule(
  root: BootedRootModule,
  layout: ApplicationLayout,
  hasLoader: boolean,
  others: readonly ApplicationLayout[],
): RootModuleEntry {
  const { build } = layout.application;
  const source: RootModuleEntry = { kind: "source", path: root.sourceFile };
  if (build.kind === "bundled") {
    return hasLoader ? source : { kind: "bundled", bundler: build.bundler };
  }

  const candidates = compiledCandidates(root.sourceFile, layout);
  const compiled = pickCompiled(candidates, layout);
  switch (compiled.kind) {
    case "missing":
      return hasLoader ? source : { kind: "not-built", candidates };
    case "both-layouts":
      return hasLoader ? source : compiled;
    case "found": {
      const otherSource = sharedWith(compiled.path, root.sourceFile, layout, others);
      if (otherSource === undefined) {
        return { kind: "compiled", path: compiled.path };
      }

      return hasLoader ? source : { kind: "shared", path: compiled.path, otherSource };
    }
    default: {
      const _exhaustive: never = compiled;
      return _exhaustive;
    }
  }
}

/**
 * The compiled file among a source's candidates: the first that exists — but
 * not when both of SWC's layouts exist, since one is left from an older build
 * of the other Nest CLI, and which cannot be told.
 */
export function pickCompiled(
  candidates: readonly string[],
  layout: ApplicationLayout,
): CompiledFile {
  const existing = candidates.filter(isFile);
  const [first] = existing;
  if (first === undefined) {
    return { kind: "missing" };
  }

  return layout.application.build.kind === "swc" && existing.length > 1
    ? { kind: "both-layouts", paths: existing }
    : { kind: "found", path: first };
}

/**
 * The source of another application's that builds to `compiled` too — the
 * one at the same path in its own source root — when there is one: whose the
 * file is cannot then be told. One file reached from both applications, a
 * library's, is no other's.
 */
function sharedWith(
  compiled: string,
  source: string,
  layout: ApplicationLayout,
  others: readonly ApplicationLayout[],
): string | undefined {
  const fromSourceRoot = relative(
    resolve(layout.projectDir, layout.application.sourceRoot),
    source,
  );
  for (const other of others) {
    const otherSource = resolve(other.projectDir, other.application.sourceRoot, fromSourceRoot);
    if (
      !samePath(otherSource, source) &&
      isFile(otherSource) &&
      compiledCandidates(otherSource, other).some((candidate) => samePath(candidate, compiled))
    ) {
      return otherSource;
    }
  }

  return undefined;
}

/**
 * Where `nest build` writes `source`, as candidates tried in order. tsc
 * writes where its tsconfig says, and only there is looked: beside the source
 * when the tsconfig sets no `outDir`, and under the `outDir` at the source's
 * path from an explicit `rootDir` — anywhere else could only hold a stale
 * file. SWC writes where `@swc/cli` names its files (`swcCandidates`).
 * Otherwise — tsc inferring its root directory, a builder the export does not
 * know, a bundle's stale output — the root directory is probed rather than
 * assumed: an explicit `rootDir`, the tsconfig's own directory, the project,
 * the application's `root`, then its `sourceRoot`.
 */
function compiledCandidates(source: string, layout: ApplicationLayout): string[] {
  const extension = COMPILED_EXTENSIONS.get(extname(source));
  if (extension === undefined) {
    return [];
  }

  const { application, projectDir, tsconfig } = layout;
  const compiledName = (path: string) =>
    path.slice(0, path.length - extname(path).length) + extension;
  const { build } = application;
  if (build.kind === "swc") {
    // @swc/cli names the output `.${outFileExtension}` when it is set.
    const swcExtension =
      build.outFileExtension === undefined ? extension : `.${build.outFileExtension}`;
    return swcCandidates(source, layout, build).map(
      (path) => path.slice(0, path.length - extname(path).length) + swcExtension,
    );
  }

  const tsc = build.kind === "tsc";
  if (tsc && tsconfig !== undefined && tsconfig.options.outDir === undefined) {
    return [compiledName(source)];
  }

  const outDir = outDirOf(projectDir, tsconfig);
  const rootDir = tsconfig?.options.rootDir;
  const roots =
    tsc && rootDir !== undefined
      ? [rootDir]
      : [
          rootDir,
          tsconfig ? dirname(tsconfig.path) : undefined,
          projectDir,
          resolve(projectDir, application.root),
          resolve(projectDir, application.sourceRoot),
        ];
  const candidates = roots.flatMap((root) => {
    const path = root === undefined ? undefined : pathInside(root, source);
    return path === undefined ? [] : [join(outDir, compiledName(path))];
  });

  return [...new Set(candidates)];
}

/**
 * Where `@swc/cli` writes `source` when the Nest CLI runs it, before the
 * extension changes. Its `getDest` takes the source's path from the project,
 * strips its first directory under `stripLeadingPaths`, and joins it to the
 * outDir — the builder's `options.outDir`, else the tsconfig's, else `dist`
 * (`swc-defaults.ts`). The builder's own `stripLeadingPaths` decides when it
 * sets one. Otherwise Nest CLI 12 strips only a source root of one directory,
 * and only when the tsconfig's `rootDir` is unset or is that source root,
 * while Nest CLI 11 always strips: both layouts are candidates, 12's first.
 */
function swcCandidates(
  source: string,
  layout: ApplicationLayout,
  build: Extract<ApplicationBuild, { kind: "swc" }>,
): string[] {
  const { application, projectDir, tsconfig } = layout;
  const fromProject = pathInside(projectDir, source);
  if (fromProject === undefined) {
    return [];
  }

  const outDir =
    build.outDir === undefined
      ? outDirOf(projectDir, tsconfig)
      : resolve(projectDir, build.outDir);
  const whole = join(outDir, fromProject);
  // @swc/cli's stripComponents: every directory but the first, or the path
  // itself when it has no directory.
  const [, ...rest] = fromProject.split(sep);
  const stripped = rest.length ? join(outDir, ...rest) : whole;

  if (build.stripLeadingPaths !== undefined) {
    return [build.stripLeadingPaths ? stripped : whole];
  }

  return nestCli12StripsLeadingPaths(tsconfig?.options.rootDir, application.sourceRoot)
    ? [stripped]
    : [...new Set([whole, stripped])];
}

/**
 * Whether Nest CLI 12 runs `@swc/cli` with `stripLeadingPaths`, as its
 * `shouldStripLeadingPaths` decides: never for a source root of more than one
 * directory, which stripping could not flatten; else when the tsconfig sets no
 * `rootDir`, or one that is the source root.
 */
function nestCli12StripsLeadingPaths(
  rootDir: string | undefined,
  sourceRoot: string,
): boolean {
  const posix = (path: string) =>
    path.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/\/+/g, "/");
  const root = posix(sourceRoot).replace(/^\.\//, "").replace(/\/+$/, "");
  if (root.includes("/")) {
    return false;
  }

  if (rootDir === undefined) {
    return true;
  }

  const directory = posix(rootDir).replace(/\/+$/, "");
  return directory === root || directory.endsWith(`/${root}`);
}

/** The conventional root module file, as source: `app.module.ts`, beside main.ts. */
const CONVENTIONAL_ROOT_MODULE = "app.module.ts";

/**
 * Where an application's own build writes its conventional root module,
 * `<sourceRoot>/app.module.ts`: the candidates `compiledCandidates` finds for
 * any root module's file — so under an explicit `rootDir`, only the path tsc
 * writes, and the flattened `<outDir>/app.module.js` only where the build can
 * write it. A bundle writes none.
 */
export function conventionalEntryCandidates(layout: ApplicationLayout): string[] {
  const { application, projectDir } = layout;
  return application.build.kind === "bundled"
    ? []
    : compiledCandidates(
        resolve(projectDir, application.sourceRoot, CONVENTIONAL_ROOT_MODULE),
        layout,
      );
}

/** Where an application's entry file may be, as source: `<sourceRoot>/<entryFile>` with each extension. */
function entryFileSources({ application, projectDir }: ApplicationLayout): string[] {
  const stem = resolve(projectDir, application.sourceRoot, application.entryFile);
  return ENTRY_FILE_EXTENSIONS.map((extension) => stem + extension);
}

/** The one file webpack and rspack bundle an application into: `main.js`, after its entry file. */
function bundleFileName(application: NestApplication): string {
  return `${basename(application.entryFile)}.js`;
}

/**
 * Every path an application's entry file has: its source and what it compiles
 * or bundles to. The export never selects one of them to load, whatever it
 * contains.
 */
function applicationEntryFiles(layout: ApplicationLayout): string[] {
  const { application, projectDir, tsconfig } = layout;
  const sources = entryFileSources(layout);
  // Where webpack and rspack write a bundled build's one file: dist/, then
  // the application's root and its entry file, as Nest's webpack defaults
  // name it — and flattened into the outDir. Only a bundled build has one; in
  // a compiled build those paths can be ordinary module files.
  const bundles =
    application.build.kind === "bundled"
      ? [
          join(projectDir, DEFAULT_OUT_DIR, application.root, `${application.entryFile}.js`),
          join(outDirOf(projectDir, tsconfig), bundleFileName(application)),
        ]
      : [];

  return [
    ...sources,
    ...sources.flatMap((source) => compiledCandidates(source, layout)),
    ...bundles,
  ];
}

/**
 * The entry files of the default project and of every named application, as
 * far as they can be worked out — the check for `NestFactory` calls runs on
 * the file regardless.
 */
function entryFilesOf({ projectDir, cwd, config }: LoadingProject): string[] {
  return readEveryLayout(projectDir, config, cwd).flatMap(applicationEntryFiles);
}

/**
 * Checks the one file the export is about to load — `--entry`'s, the
 * convention's, or the one found from main.ts — and refuses it when it calls a
 * method of `NestFactory` — main.ts compiled by tsc
 * (`core_1.NestFactory.create(...)`), a webpack bundle
 * (`_nestjs_core__WEBPACK_IMPORTED_MODULE_0__.NestFactory.create(...)`), one
 * that imports `NestFactory` under another name — or when it is, by its path,
 * the entry file of an application nest-cli.json defines. Paths are compared
 * as the file system resolves them: symlinks followed, case folded where the
 * file system ignores it.
 *
 * Only that file is checked. The modules it imports load with it, unread, so
 * a root module file that imports main.ts, or a file that boots the
 * application, still starts it. Returns the path that was checked, symlinks
 * resolved: the one to load.
 */
export function assertLoadableEntry(path: string, project: LoadingProject): string {
  const file = displayPath(path, project.cwd);
  let checked: string;
  let text: string;
  try {
    checked = realpathSync(path);
    text = readFileSync(checked, "utf8");
  } catch (error) {
    throw new CliError(`Cannot read ${file}: ${describeError(error)}`);
  }

  const call = findNestFactoryCall(parseSourceFile(checked, text));
  const target = foldCase(checked);
  // An entry file can start the application without calling NestFactory
  // itself — through a bootstrap function it imports, say.
  const reason =
    call !== undefined
      ? `it calls ${call}`
      : entryFilesOf(project).some((entry) => canonicalKey(entry) === target)
        ? "it is the application's entry file"
        : undefined;

  if (reason !== undefined) {
    throw new CliError(
      `${file} starts the application (${reason}), so the export will not load it: loading it would run your bootstrap — listen on a port, connect to a database. Point --entry at the file that exports your root module (e.g. dist/app.module.js).`,
    );
  }

  return checked;
}

/**
 * A path as the file system resolves it — symlinks followed, case folded
 * where the file system ignores case — to tell whether two paths name one
 * file. Undefined when nothing is there.
 */
function canonicalKey(path: string): string | undefined {
  try {
    return foldCase(realpathSync(path));
  } catch {
    return undefined;
  }
}

function foldCase(path: string): string {
  return ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase();
}

/**
 * Whether two paths name one file or directory: compared as the file system
 * resolves them where something is there, else by their resolved spelling.
 */
export function samePath(left: string, right: string): boolean {
  const key = (path: string) => canonicalKey(path) ?? foldCase(resolve(path));
  return key(left) === key(right);
}

/**
 * The first call in a file made through `NestFactory` — `NestFactory.create`,
 * `core_1.NestFactory.create`, `F.create` after `import { NestFactory as F }`
 * — described as `NestFactory.create`; undefined when there is none.
 */
export function findNestFactoryCall(sourceFile: ts.SourceFile): string | undefined {
  const aliases = collectNestFactoryAliases(sourceFile);
  let found: string | undefined;
  const visit = (node: ts.Node): boolean | undefined => {
    if (ts.isCallExpression(node)) {
      const call = nestFactoryCall(node, aliases);
      if (call) {
        found = `${NEST_FACTORY}${call.method === undefined ? "[…]" : `.${call.method}`}`;
        return true;
      }
    }

    return ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return found;
}

/** The root module's name as a user knows it: its export name, or main.ts's name for a default export. */
function rootName(root: BootedRootModule): string {
  return root.exportName === "default" ? root.localName : root.exportName;
}

export function declaresRootMessage(
  mainFile: string,
  name: string,
  cwd: string,
): string {
  const main = displayPath(mainFile, cwd);
  return `${main} declares its root module ${name} itself, and loading ${main} would start the application, so the export will not load it. Move ${name} into a file of its own that ${main} imports, or pass --entry with a file that exports your root module and does not start the application.`;
}

/**
 * What to build: the project, as `nest build` without a name builds its
 * default; or `--app`'s application, which only `nest build <name>` builds.
 */
export function buildAdvice(app: string | undefined): string {
  return app === undefined
    ? "Build your project first (nest build)"
    : `Build ${app} first (nest build ${app})`;
}

export function notBuiltMessage(params: {
  mainFile: string;
  root: BootedRootModule;
  candidates: readonly string[];
  command: string;
  /** `--app`, when it names the application. */
  app: string | undefined;
  cwd: string;
}): string {
  const { mainFile, root, candidates, command, app, cwd } = params;
  const built = candidates.length
    ? ` to ${candidates.map((path) => displayPath(path, cwd)).join(" or ")}`
    : "";
  return `No compiled ${rootName(root)} found: ${displayPath(mainFile, cwd)} boots it from ${displayPath(root.sourceFile, cwd)}, which has not been built${built}. ${buildAdvice(app)}, or run: ${command}`;
}

export function bothLayoutsMessage(params: {
  mainFile: string;
  root: BootedRootModule;
  paths: readonly string[];
  command: string;
  cwd: string;
}): string {
  const { mainFile, root, paths, command, cwd } = params;
  return `${displayPath(mainFile, cwd)} boots ${rootName(root)} from ${displayPath(root.sourceFile, cwd)}, which SWC has built to both ${paths.map((path) => displayPath(path, cwd)).join(" and ")}: Nest CLI 12 and Nest CLI 11 lay out its output differently, so one of them is left from an older build. Pass --entry with the current one, build again into an emptied outDir, or run: ${command}`;
}

export function sharedOutputMessage(params: {
  mainFile: string;
  root: BootedRootModule;
  path: string;
  otherSource: string;
  command: string;
  cwd: string;
}): string {
  const { mainFile, root, path, otherSource, command, cwd } = params;
  const compiled = displayPath(path, cwd);
  return `${displayPath(mainFile, cwd)} boots ${rootName(root)} from ${displayPath(root.sourceFile, cwd)}, built to ${compiled} — but another application's ${displayPath(otherSource, cwd)} builds to ${compiled} too, so whose it is cannot be told. Pass --entry with the file to load, or load the TypeScript source: ${command}`;
}

export function bundledMessage(params: {
  application: NestApplication;
  bundler: Bundler;
  root: BootedRootModule;
  command: string;
  cwd: string;
}): string {
  const { application, bundler, root, command, cwd } = params;
  const label = application.root || application.name || "The project";

  return `${label} is built with ${bundler} into one ${bundleFileName(application)}, which starts the application when it is loaded. Its root module is ${rootName(root)} in ${displayPath(root.sourceFile, cwd)}. Run: ${command}`;
}

export function forRootWarning(
  mainFile: string,
  root: BootedRootModule,
  cwd: string,
): string | undefined {
  return root.dynamicMethod === undefined
    ? undefined
    : `${displayPath(mainFile, cwd)} boots ${root.localName}.${root.dynamicMethod}(...); exporting ${rootName(root)} without the options ${basename(mainFile)} passes to it.`;
}

/**
 * The command that exports the root module from its TypeScript source: the
 * command line as given, with the loaders it needs — ts-node, which emits the
 * decorator metadata Nest reads, and tsconfig-paths when the tsconfig maps
 * `paths`. Both read the project's `tsconfig.json` unless `TS_NODE_PROJECT`
 * names another, resolved from the project, where the export runs: so when
 * the application builds with another tsconfig, the command sets it, POSIX
 * shell style. Never installed or chosen for the user: only suggested.
 */
export function loaderCommand(
  argv: readonly string[],
  layout: ApplicationLayout,
): string {
  const { projectDir, tsconfig } = layout;
  const paths = tsconfig?.options.paths;
  const loaders = [
    "ts-node/register",
    ...(paths && Object.keys(paths).length ? ["tsconfig-paths/register"] : []),
  ];
  const project =
    tsconfig !== undefined && !samePath(tsconfig.path, join(projectDir, "tsconfig.json"))
      ? [`TS_NODE_PROJECT=${shellQuote(pathInside(projectDir, tsconfig.path) ?? tsconfig.path)}`]
      : [];

  return [
    ...project,
    ...["nest-graph-inspector", ...argv, ...loaders.flatMap((loader) => ["--require", loader])].map(
      shellQuote,
    ),
  ].join(" ");
}

function shellQuote(argument: string): string {
  return /^[\w@%+=:,./-]+$/.test(argument)
    ? argument
    : `'${argument.replace(/'/g, `'\\''`)}'`;
}

/**
 * What main.ts boots, when that is clear — one root module, traced from the
 * file main.ts imports it from, through its re-exports, to the class's own
 * file — for checking an entry found by convention against. Undefined
 * whenever it is not clear; never throws.
 */
export function conventionCheck(layout: ApplicationLayout): ConventionCheck | undefined {
  try {
    const analysis = analyseMainFile(layout);
    if (analysis.kind !== "boots" || analysis.roots.length !== 1) {
      return undefined;
    }

    const [booted] = analysis.roots;
    const declared = declaringExport({
      file: booted.sourceFile,
      exportName: booted.exportName,
      layout,
      trail: new Set(),
    });
    if (declared === undefined) {
      return undefined;
    }

    const root = { ...booted, sourceFile: declared.file, exportName: declared.exportName };
    return {
      mainFile: analysis.mainFile,
      root,
      compiled: compiledCandidates(root.sourceFile, layout),
    };
  } catch {
    // Only ever a warning: a project the analysis cannot read gets none.
    return undefined;
  }
}

/**
 * The file that declares the class a module exports as `exportName`, and the
 * name that file exports it under: `file` itself, or — following static
 * re-exports, `export { X } from`, `export { X as Y } from`, an import it
 * exports again, and `export * from`, at most MAX_REEXPORT_DEPTH files on —
 * the file a barrel takes it from. As in a module, an explicit export of the
 * name hides any `export *` that has it too. The lookup never enters the same
 * file for the same name twice on one trail, so a cycle ends, while a sibling
 * `export *` may still look in a file for another name. Undefined when the
 * trail leads nowhere it can read.
 */
function declaringExport(lookup: {
  file: string;
  exportName: string;
  layout: ApplicationLayout;
  /** The files and names the lookup is already inside of. */
  trail: ReadonlySet<string>;
}): { file: string; exportName: string } | undefined {
  const { file, exportName, layout, trail } = lookup;
  const step = JSON.stringify([file, exportName]);
  if (trail.size > MAX_REEXPORT_DEPTH || trail.has(step)) {
    return undefined;
  }

  const sourceFile = parseSourceFile(file, readFileSync(file, "utf8"));
  const onTrail = new Set(trail).add(step);
  const follow = (specifier: string, name: string) => {
    const target = resolveImport(specifier, file, layout);
    return target === undefined
      ? undefined
      : declaringExport({ file: target, exportName: name, layout, trail: onTrail });
  };

  const explicit = explicitExport(sourceFile, exportName);
  switch (explicit?.kind) {
    case "declared":
      return { file, exportName };
    case "reexported":
      return follow(explicit.specifier, explicit.name);
    case "opaque":
      return undefined;
    case undefined:
      break;
    default: {
      const _exhaustive: never = explicit;
      return _exhaustive;
    }
  }

  // `export * from` re-exports every name but `default`.
  if (exportName === "default") {
    return undefined;
  }

  for (const specifier of starExports(sourceFile)) {
    const found = follow(specifier, exportName);
    if (found !== undefined) {
      return found;
    }
  }

  return undefined;
}

/** How a module exports a name itself, rather than through `export *`. */
type ExplicitExport =
  /** It declares the class: `export class X`, `export default class`, `export { Local as X }`. */
  | { kind: "declared" }
  /** It takes it from another module: `export { Y as X } from`, or an import it exports. */
  | { kind: "reexported"; specifier: string; name: string }
  /** Something no class can be traced through: a namespace, a value. */
  | { kind: "opaque" };

/**
 * How a module exports `exportName` itself; undefined when it does not, and
 * the name is whatever its `export *`s give it.
 */
function explicitExport(
  sourceFile: ts.SourceFile,
  exportName: string,
): ExplicitExport | undefined {
  const imports = importedBindings(sourceFile);
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (exportName !== "default") {
        continue;
      }

      // export default RootModule: the class, wherever that name comes from.
      const value = unwrap(statement.expression);
      return (ts.isIdentifier(value)
        ? moduleBinding(sourceFile, value.text, imports, 0)
        : undefined) ?? { kind: "declared" };
    }

    if (ts.isClassDeclaration(statement) && exportsClassAs(statement, exportName)) {
      return { kind: "declared" };
    }

    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      // export const RootModule = AppModule: the name is this one, whatever an
      // export * has — traced through a plain alias, and no further.
      const declared = statement.declarationList.declarations.find((declaration) =>
        bindsName(declaration.name, exportName),
      );
      if (declared !== undefined) {
        return ts.isIdentifier(declared.name)
          ? constantExport(declared, statement.declarationList, sourceFile, imports, 0)
          : { kind: "opaque" };
      }

      continue;
    }

    if (
      (ts.isFunctionDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      statement.name?.text === exportName
    ) {
      return { kind: "opaque" };
    }

    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) {
      continue;
    }

    const clause = statement.exportClause;
    const specifier =
      statement.moduleSpecifier !== undefined && ts.isStringLiteralLike(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    if (clause !== undefined && ts.isNamespaceExport(clause)) {
      if (clause.name.text === exportName) {
        return { kind: "opaque" };
      }
      continue;
    }

    const element = clause?.elements.find(
      (candidate) => !candidate.isTypeOnly && candidate.name.text === exportName,
    );
    if (element === undefined) {
      continue;
    }

    const local = (element.propertyName ?? element.name).text;
    if (specifier !== undefined) {
      return { kind: "reexported", specifier, name: local };
    }

    // export { Local as X }: a class declared here, an import, or an alias.
    return moduleBinding(sourceFile, local, imports, 0) ?? { kind: "opaque" };
  }

  return undefined;
}

/**
 * What a name declared at a module's top level is, to export: a class
 * declared there, an import, or — through `const X = Y` — what `Y` is.
 * Undefined when it is none of these.
 */
function moduleBinding(
  sourceFile: ts.SourceFile,
  name: string,
  imports: ReadonlyMap<string, ExplicitExport>,
  depth: number,
): ExplicitExport | undefined {
  const imported = imports.get(name);
  if (imported !== undefined) {
    return imported;
  }

  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
      return { kind: "declared" };
    }

    const declared = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.find(
          (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name,
        )
      : undefined;
    if (declared !== undefined && ts.isVariableStatement(statement)) {
      return constantExport(declared, statement.declarationList, sourceFile, imports, depth);
    }
  }

  return undefined;
}

/**
 * A top-level variable, exported or exported again: a class expression it is
 * set to, or — for a `const` set to a plain name — what that name is, at most
 * MAX_CONSTANT_DEPTH aliases on. Anything else cannot be traced to a class.
 * `list` is the declaration's own: a file parsed here has no parent links.
 */
function constantExport(
  declaration: ts.VariableDeclaration,
  list: ts.VariableDeclarationList,
  sourceFile: ts.SourceFile,
  imports: ReadonlyMap<string, ExplicitExport>,
  depth: number,
): ExplicitExport {
  const value =
    declaration.initializer === undefined ? undefined : unwrap(declaration.initializer);
  if (
    value === undefined ||
    (list.flags & ts.NodeFlags.Const) === 0 ||
    depth >= MAX_CONSTANT_DEPTH
  ) {
    return { kind: "opaque" };
  }

  if (ts.isClassExpression(value)) {
    return { kind: "declared" };
  }

  return ts.isIdentifier(value)
    ? (moduleBinding(sourceFile, value.text, imports, depth + 1) ?? { kind: "opaque" })
    : { kind: "opaque" };
}

/** Whether a declaration's name — a destructuring pattern's included — binds `name`. */
function bindsName(name: ts.BindingName, wanted: string): boolean {
  return ts.isIdentifier(name)
    ? name.text === wanted
    : name.elements.some(
        (element) => !ts.isOmittedExpression(element) && bindsName(element.name, wanted),
      );
}

function hasModifier(node: ts.HasModifiers, kind: ts.SyntaxKind): boolean {
  return (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

/** Whether a class declaration exports the class as `exportName`: `export class X`, or `export default class`. */
function exportsClassAs(statement: ts.ClassDeclaration, exportName: string): boolean {
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
    return false;
  }

  const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
  return exportName === "default"
    ? isDefault
    : !isDefault && statement.name?.text === exportName;
}

/** A module's value imports, by local name, as what exporting each again would be. */
function importedBindings(sourceFile: ts.SourceFile): ReadonlyMap<string, ExplicitExport> {
  const bindings = new Map<string, ExplicitExport>();
  for (const statement of sourceFile.statements) {
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    if (
      !ts.isImportDeclaration(statement) ||
      clause === undefined ||
      clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }

    const specifier = statement.moduleSpecifier.text;
    if (clause.name) {
      bindings.set(clause.name.text, { kind: "reexported", specifier, name: "default" });
    }

    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) {
      bindings.set(named.name.text, { kind: "opaque" });
    } else if (named) {
      for (const element of named.elements) {
        if (!element.isTypeOnly) {
          bindings.set(element.name.text, {
            kind: "reexported",
            specifier,
            name: (element.propertyName ?? element.name).text,
          });
        }
      }
    }
  }

  return bindings;
}

/** The modules a file re-exports every name of: `export * from`. */
function starExports(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) =>
    ts.isExportDeclaration(statement) &&
    !statement.isTypeOnly &&
    statement.exportClause === undefined &&
    statement.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(statement.moduleSpecifier)
      ? [statement.moduleSpecifier.text]
      : [],
  );
}

/**
 * Warnings for an entry found by convention, once its root module export has
 * been chosen: when main.ts boots a module from another file, or another
 * export of the same file, and when it boots the same one through
 * `.forRoot()`, whose options the export goes without.
 */
export function conventionWarnings(
  check: ConventionCheck,
  entry: { path: string; moduleName: string; requestedModule: string | undefined },
  cwd: string,
): string[] {
  const { mainFile, root, compiled } = check;
  const main = displayPath(mainFile, cwd);
  const name = rootName(root);
  const boots = `${main} boots ${name} from ${displayPath(root.sourceFile, cwd)}, but the export uses ${displayPath(entry.path, cwd)} (${entry.moduleName}) by convention.`;
  const sameFile = compiled.some((path) => samePath(path, entry.path));

  if (!sameFile) {
    const built = compiled.find(isFile);
    return [
      built === undefined
        ? `${boots} Pass --entry/--module to export ${name}.`
        : `${boots} Pass --entry ${displayPath(built, cwd)} --module ${root.exportName} to export ${name}.`,
    ];
  }

  if (entry.moduleName !== root.exportName) {
    return entry.requestedModule === undefined
      ? [`${boots} Pass --module ${root.exportName} to export ${name}.`]
      : [];
  }

  const forRoot = forRootWarning(mainFile, root, cwd);
  return forRoot === undefined ? [] : [forRoot];
}

function parseSourceFile(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    false,
    scriptKindOf(path),
  );
}

function scriptKindOf(path: string): ts.ScriptKind {
  switch (extname(path)) {
    case ".ts":
    case ".mts":
    case ".cts":
      return ts.ScriptKind.TS;
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    default:
      return ts.ScriptKind.JS;
  }
}

/**
 * main.ts parsed and bound as a program of its own, for the checker to tell
 * which declaration each name in it refers to, scope by scope. Nothing else
 * is read: no import is resolved, and no lib is loaded.
 */
function parseWithScopes(path: string, text: string): BoundMainFile {
  const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));
  const target = resolve(path);
  const isTarget = (fileName: string) => resolve(fileName) === target;
  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => (isTarget(fileName) ? parsed : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => dirname(path),
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => "\n",
    fileExists: isTarget,
    readFile: (fileName) => (isTarget(fileName) ? text : undefined),
  };
  const program = ts.createProgram({
    rootNames: [path],
    options: { noLib: true, noResolve: true, allowJs: true, noEmit: true, types: [] },
    host,
  });

  return {
    sourceFile: program.getSourceFile(path) ?? parsed,
    checker: program.getTypeChecker(),
  };
}

/**
 * The first argument of every direct `NestFactory.create`-style call, in source
 * order — counting only the `NestFactory` main.ts takes from `@nestjs/core`,
 * each name resolved in its own scope: an object of main.ts's own that shares
 * the name, or a parameter, catch variable or local declaration that shadows
 * the import, boots nothing. (The load guard, which only refuses, counts any
 * `NestFactory`, scopes or not.)
 */
function findBootCalls(main: BoundMainFile): (ts.Expression | undefined)[] {
  const calls: (ts.Expression | undefined)[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = coreReference(node.expression, main, 0);
      if (callee?.kind === "method" && callee.name !== undefined && BOOT_METHODS.has(callee.name)) {
        const argument: ts.Expression | undefined = node.arguments[0];
        calls.push(argument);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(main.sourceFile);

  return calls;
}

/** What an expression in main.ts is of `@nestjs/core`: the module, its `NestFactory`, or one of that's methods. */
type CoreReference =
  | { kind: "module" }
  | { kind: "factory" }
  /** `create`; undefined for a computed `NestFactory[name]`. */
  | { kind: "method"; name: string | undefined };

/**
 * How many declarations a name is followed through to `@nestjs/core`:
 * `const F = core.NestFactory`, then `const G = F`, and so on.
 */
const MAX_ALIAS_DEPTH = 5;

/**
 * What an expression refers to of `@nestjs/core`, if anything: `require()` or
 * `import()` of it, a member of something that does, or a name whose
 * declaration — the one the checker finds for it in its own scope — binds it
 * to one of those.
 */
function coreReference(
  expression: ts.Expression,
  main: BoundMainFile,
  depth: number,
): CoreReference | undefined {
  if (depth > MAX_ALIAS_DEPTH) {
    return undefined;
  }

  const { base, names } = memberChain(expression);
  let reference: CoreReference | undefined = isCoreModuleCall(base, main)
    ? { kind: "module" }
    : ts.isIdentifier(base)
      ? declaredReference(main.checker.getSymbolAtLocation(base), main, depth)
      : undefined;
  for (const name of names) {
    reference = memberOf(reference, name);
  }

  return reference;
}

/** `<core>.NestFactory` is the factory, and `<factory>.<name>` one of its methods. */
function memberOf(
  reference: CoreReference | undefined,
  name: string | undefined,
): CoreReference | undefined {
  switch (reference?.kind) {
    case "module":
      return name === NEST_FACTORY ? { kind: "factory" } : undefined;
    case "factory":
      return { kind: "method", name };
    default:
      return undefined;
  }
}

/**
 * What a name's declaration binds it to of `@nestjs/core`: an import of the
 * package or its `NestFactory`, or a variable that still holds one. A
 * parameter, a catch clause's variable, a function or a class binds nothing of
 * it, and nor does a variable assigned anything else after its declaration.
 */
function declaredReference(
  symbol: ts.Symbol | undefined,
  main: BoundMainFile,
  depth: number,
): CoreReference | undefined {
  const declaration = symbol?.declarations?.[0];
  if (symbol === undefined || declaration === undefined) {
    return undefined;
  }

  if (ts.isImportSpecifier(declaration)) {
    const imported = (declaration.propertyName ?? declaration.name).text;
    return !declaration.isTypeOnly &&
      valueImportSpecifier(declaration.parent.parent) === NEST_CORE &&
      imported === NEST_FACTORY
      ? { kind: "factory" }
      : undefined;
  }

  if (ts.isNamespaceImport(declaration)) {
    return valueImportSpecifier(declaration.parent) === NEST_CORE
      ? { kind: "module" }
      : undefined;
  }

  if (ts.isImportClause(declaration)) {
    // import core from "@nestjs/core": the CommonJS module itself.
    return valueImportSpecifier(declaration) === NEST_CORE ? { kind: "module" } : undefined;
  }

  if (ts.isImportEqualsDeclaration(declaration)) {
    return importEqualsSpecifier(declaration) === NEST_CORE ? { kind: "module" } : undefined;
  }

  if (ts.isVariableDeclaration(declaration)) {
    return declaration.initializer === undefined ||
      !holdsItsInitializer(declaration, symbol, main)
      ? undefined
      : coreReference(declaration.initializer, main, depth + 1);
  }

  const destructured = destructuredFrom(declaration, symbol, main);
  // const { NestFactory } = require("@nestjs/core"); const { create } = NestFactory;
  return destructured === undefined
    ? undefined
    : memberOf(coreReference(destructured.initializer, main, depth + 1), destructured.property);
}

/** The module a value import clause imports from: `import … from "<module>"`. */
function valueImportSpecifier(clause: ts.ImportClause): string | undefined {
  const { moduleSpecifier } = clause.parent;
  return clause.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
    ts.isStringLiteralLike(moduleSpecifier)
    ? moduleSpecifier.text
    : undefined;
}

/** The module `import x = require("<module>")` binds. */
function importEqualsSpecifier(declaration: ts.ImportEqualsDeclaration): string | undefined {
  const reference = declaration.moduleReference;
  return !declaration.isTypeOnly &&
    ts.isExternalModuleReference(reference) &&
    ts.isStringLiteralLike(reference.expression)
    ? reference.expression.text
    : undefined;
}

/**
 * A name destructured from a variable's initializer — `const { X: Y } = …` —
 * as that initializer and the property taken from it, while the name still
 * holds what it was declared with.
 */
function destructuredFrom(
  declaration: ts.Declaration,
  symbol: ts.Symbol,
  main: BoundMainFile,
): { initializer: ts.Expression; property: string | undefined } | undefined {
  if (
    !ts.isBindingElement(declaration) ||
    declaration.dotDotDotToken !== undefined ||
    !ts.isObjectBindingPattern(declaration.parent) ||
    !ts.isVariableDeclaration(declaration.parent.parent)
  ) {
    return undefined;
  }

  const variable = declaration.parent.parent;
  if (variable.initializer === undefined || !holdsItsInitializer(variable, symbol, main)) {
    return undefined;
  }

  return {
    initializer: variable.initializer,
    property: declaration.propertyName
      ? propertyNameText(declaration.propertyName)
      : ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : undefined,
  };
}

/**
 * Whether a variable still holds what it was declared with wherever it is
 * used: a `const`, or a `let` or `var` declared once and never assigned again.
 * Only then is following its initializer to know what it refers to sound.
 */
function holdsItsInitializer(
  variable: ts.VariableDeclaration,
  symbol: ts.Symbol,
  main: BoundMainFile,
): boolean {
  const list = variable.parent;
  if (ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0) {
    return true;
  }

  return symbol.declarations?.length === 1 && !isAssignedAgain(symbol, main);
}

/** Whether anything in main.ts assigns to a variable after its declaration. */
function isAssignedAgain(symbol: ts.Symbol, main: BoundMainFile): boolean {
  const { checker } = main;
  const refersTo = (node: ts.Identifier) =>
    checker.getSymbolAtLocation(node) === symbol ||
    (ts.isShorthandPropertyAssignment(node.parent) &&
      checker.getShorthandAssignmentValueSymbol(node.parent) === symbol);
  let assigned = false;
  const visit = (node: ts.Node): void => {
    if (assigned) {
      return;
    }

    if (ts.isIdentifier(node) && node.text === symbol.name && isWriteTarget(node) && refersTo(node)) {
      assigned = true;
      return;
    }

    ts.forEachChild(node, visit);
  };
  visit(main.sourceFile);

  return assigned;
}

/**
 * Whether an identifier is written to where it stands: the left of an
 * assignment, directly or inside a destructuring one, `++`/`--`, or the
 * variable of `for (… in/of …)`.
 */
function isWriteTarget(identifier: ts.Identifier): boolean {
  let child: ts.Node = identifier;
  let parent = identifier.parent;
  while (
    ts.isParenthesizedExpression(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isObjectLiteralExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isSpreadAssignment(parent) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === child) ||
    (ts.isPropertyAssignment(parent) && parent.initializer === child)
  ) {
    child = parent;
    parent = parent.parent;
  }

  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    return (
      parent.left === child &&
      operator >= ts.SyntaxKind.FirstAssignment &&
      operator <= ts.SyntaxKind.LastAssignment
    );
  }

  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return (
      parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken
    );
  }

  return (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === child;
}

/**
 * `require("x")` → `x`, when `require` is CommonJS's own: a name main.ts
 * declares itself — a parameter, say — is not it.
 */
function freeRequireSpecifier(
  expression: ts.Expression,
  main: BoundMainFile,
): string | undefined {
  const call = unwrap(expression);
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "require" ||
    call.arguments.length !== 1 ||
    main.checker.getSymbolAtLocation(call.expression)?.declarations?.length
  ) {
    return undefined;
  }

  const specifier = call.arguments[0];
  return ts.isStringLiteralLike(specifier) ? specifier.text : undefined;
}

/** `require("@nestjs/core")`, or `import("@nestjs/core")`. */
function isCoreModuleCall(expression: ts.Expression, main: BoundMainFile): boolean {
  if (freeRequireSpecifier(expression, main) === NEST_CORE) {
    return true;
  }

  if (
    !ts.isCallExpression(expression) ||
    expression.expression.kind !== ts.SyntaxKind.ImportKeyword ||
    expression.arguments.length !== 1
  ) {
    return false;
  }

  const specifier = expression.arguments[0];
  return ts.isStringLiteralLike(specifier) && specifier.text === NEST_CORE;
}

/**
 * Whether a call goes through `NestFactory`: its callee is a member chain
 * holding `NestFactory` — `NestFactory.create`, `core.NestFactory.create`,
 * `require("@nestjs/core").NestFactory.create` — or starting from a local
 * name bound to it, or to one of its methods.
 */
function nestFactoryCall(
  call: ts.CallExpression,
  aliases: NestFactoryAliases,
): NestFactoryCall | undefined {
  const { base, names } = memberChain(call.expression);
  if (ts.isIdentifier(base) && aliases.methods.has(base.text)) {
    // create(...) after const { create } = NestFactory.
    return { method: aliases.methods.get(base.text), direct: names.length === 0 };
  }

  let method: number;
  if (isNestFactory(base, aliases)) {
    method = 0;
  } else {
    const at = names.indexOf(NEST_FACTORY);
    if (at === -1) {
      return undefined;
    }

    method = at + 1;
  }

  // NestFactory itself, called: not a method of it.
  if (method >= names.length) {
    return undefined;
  }

  return { method: names[method], direct: method === names.length - 1 };
}

/** Local names bound to `NestFactory`, or to one of its methods. */
type NestFactoryAliases = {
  /** For `NestFactory` itself: `F` after `import { NestFactory as F }`. */
  factories: Set<string>;
  /** For one of its methods, to the method: `create` after `const { create } = NestFactory`. */
  methods: Map<string, string | undefined>;
};

/**
 * The local names bound to `NestFactory` — imported under another name,
 * declared with it or assigned it later, or destructured from it — or to one
 * of its methods. Scopes are not told apart: a name bound so anywhere counts
 * everywhere in the file, which only ever refuses more.
 */
function collectNestFactoryAliases(sourceFile: ts.SourceFile): NestFactoryAliases {
  const aliases: NestFactoryAliases = { factories: new Set(), methods: new Map() };
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === NEST_FACTORY) {
      aliases.factories.add(node.name.text);
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      collectVariableAlias(node.name, node.initializer, aliases);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(unwrap(node.left))
    ) {
      // let F; F = NestFactory;
      collectVariableAlias(unwrap(node.left) as ts.Identifier, node.right, aliases);
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return aliases;
}

function collectVariableAlias(
  name: ts.BindingName,
  initializer: ts.Expression,
  aliases: NestFactoryAliases,
): void {
  const fromFactory = refersToNestFactory(initializer, aliases);
  if (ts.isIdentifier(name)) {
    const method = fromFactory ? undefined : nestFactoryMethod(initializer, aliases);
    if (fromFactory) {
      // const F = require("@nestjs/core").NestFactory;
      aliases.factories.add(name.text);
    } else if (method) {
      // const create = NestFactory.create;
      aliases.methods.set(name.text, method.name);
    }
    return;
  }

  if (!ts.isObjectBindingPattern(name)) {
    return;
  }

  for (const element of name.elements) {
    if (!ts.isIdentifier(element.name)) {
      continue;
    }

    const property = element.propertyName
      ? propertyNameText(element.propertyName)
      : element.name.text;
    if (fromFactory) {
      // const { create } = NestFactory;
      aliases.methods.set(element.name.text, property);
    } else if (property === NEST_FACTORY) {
      // const { NestFactory: F } = require("@nestjs/core");
      aliases.factories.add(element.name.text);
    }
  }
}

function isNestFactory(expression: ts.Expression, aliases: NestFactoryAliases): boolean {
  return (
    ts.isIdentifier(expression) &&
    (expression.text === NEST_FACTORY || aliases.factories.has(expression.text))
  );
}

function refersToNestFactory(
  expression: ts.Expression,
  aliases: NestFactoryAliases,
): boolean {
  const { base, names } = memberChain(expression);
  return names.length
    ? names[names.length - 1] === NEST_FACTORY
    : isNestFactory(base, aliases);
}

/** `NestFactory.create`, as a value: the method it names. */
function nestFactoryMethod(
  expression: ts.Expression,
  aliases: NestFactoryAliases,
): { name: string | undefined } | undefined {
  const { base, names } = memberChain(expression);
  const last = names.length - 1;
  if (last < 0) {
    return undefined;
  }

  const ofFactory =
    last === 0 ? isNestFactory(base, aliases) : names[last - 1] === NEST_FACTORY;
  return ofFactory ? { name: names[last] } : undefined;
}

/**
 * `a.b["c"].d` as its base `a` and the names `b`, `c`, `d`; a computed name
 * (`a[key]`) is undefined. Parentheses, type assertions and the like are seen
 * through.
 */
function memberChain(expression: ts.Expression): {
  base: ts.Expression;
  names: (string | undefined)[];
} {
  const names: (string | undefined)[] = [];
  let current = unwrap(expression);
  for (;;) {
    if (ts.isPropertyAccessExpression(current)) {
      names.unshift(current.name.text);
      current = unwrap(current.expression);
    } else if (ts.isElementAccessExpression(current)) {
      names.unshift(
        ts.isStringLiteralLike(current.argumentExpression)
          ? current.argumentExpression.text
          : undefined,
      );
      current = unwrap(current.expression);
    } else {
      return { base: current, names };
    }
  }
}

/**
 * Strips what does not change which value an expression is: parentheses,
 * `as`, `satisfies`, `!`, `<T>`, `await`, and all but the last operand of a
 * comma, as in compiled `(0, core_1.NestFactory.create)(...)`.
 */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      current = current.expression;
    } else if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      current = current.right;
    } else {
      return current;
    }
  }
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

/**
 * What the first argument of a `NestFactory` call refers to: an imported
 * class — `RootModule`, `mods.RootModule`, `RootModule.forRoot(...)` — a class
 * main.ts declares itself, or something only known at runtime.
 */
function analyseRootArgument(
  argument: ts.Expression,
  main: BoundMainFile,
  depth: number,
): RootArgument {
  const expression = unwrap(argument);
  if (ts.isCallExpression(expression)) {
    // RootModule.forRoot(...), RootModule.register(...): a dynamic module of
    // RootModule, whose options only exist at runtime.
    const callee = unwrap(expression.expression);
    if (!ts.isPropertyAccessExpression(callee)) {
      return { kind: "unknown" };
    }

    const target = analyseModuleReference(callee.expression, main, depth);
    return target.kind === "imported"
      ? { ...target, dynamicMethod: callee.name.text }
      : target;
  }

  return analyseModuleReference(expression, main, depth);
}

function analyseModuleReference(
  expression: ts.Expression,
  main: BoundMainFile,
  depth: number,
): RootArgument {
  const reference = unwrap(expression);
  if (ts.isIdentifier(reference)) {
    return nameReference(reference, main, depth);
  }

  if (ts.isPropertyAccessExpression(reference)) {
    // mods.RootModule, from import * as mods, or require("./root.module").RootModule
    const object = unwrap(reference.expression);
    const specifier = ts.isIdentifier(object)
      ? namespaceSpecifier(object, main)
      : freeRequireSpecifier(object, main);
    if (specifier !== undefined) {
      return {
        kind: "imported",
        specifier,
        exportName: reference.name.text,
        localName: ts.isIdentifier(object)
          ? `${object.text}.${reference.name.text}`
          : reference.name.text,
        dynamicMethod: undefined,
      };
    }
  }

  return { kind: "unknown" };
}

/**
 * What a name passed to `NestFactory` refers to, by the declaration the
 * checker finds for it in its own scope — so a local that shadows an import
 * is the local: an import, a class main.ts declares, or a variable followed
 * to what it was declared with, while it still holds that.
 */
function nameReference(
  identifier: ts.Identifier,
  main: BoundMainFile,
  depth: number,
): RootArgument {
  const name = identifier.text;
  const symbol = main.checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.declarations?.[0];
  if (symbol === undefined || declaration === undefined) {
    return { kind: "unknown" };
  }

  const imported = importedExport(declaration);
  if (imported !== undefined) {
    return { kind: "imported", ...imported, localName: name, dynamicMethod: undefined };
  }

  if (ts.isClassDeclaration(declaration)) {
    return { kind: "declared", name };
  }

  const destructured = destructuredFrom(declaration, symbol, main);
  if (destructured !== undefined) {
    // const { RootModule } = require("./root.module");
    const specifier = freeRequireSpecifier(destructured.initializer, main);
    return specifier === undefined || destructured.property === undefined
      ? { kind: "unknown" }
      : {
          kind: "imported",
          specifier,
          exportName: destructured.property,
          localName: name,
          dynamicMethod: undefined,
        };
  }

  if (
    !ts.isVariableDeclaration(declaration) ||
    declaration.initializer === undefined ||
    !holdsItsInitializer(declaration, symbol, main)
  ) {
    return { kind: "unknown" };
  }

  if (ts.isClassExpression(unwrap(declaration.initializer))) {
    return { kind: "declared", name };
  }

  return depth < MAX_CONSTANT_DEPTH
    ? analyseRootArgument(declaration.initializer, main, depth + 1)
    : { kind: "unknown" };
}

/** The module and export an import binds a name to: `import { X as Y } from`, `import X from`. */
function importedExport(
  declaration: ts.Declaration,
): { specifier: string; exportName: string } | undefined {
  if (ts.isImportSpecifier(declaration)) {
    const specifier = valueImportSpecifier(declaration.parent.parent);
    return declaration.isTypeOnly || specifier === undefined
      ? undefined
      : { specifier, exportName: (declaration.propertyName ?? declaration.name).text };
  }

  if (ts.isImportClause(declaration)) {
    const specifier = valueImportSpecifier(declaration);
    return specifier === undefined ? undefined : { specifier, exportName: "default" };
  }

  return undefined;
}

/**
 * The module a name binds whole: `import * as mods from`,
 * `import mods = require()`, or `const mods = require()` while it holds that.
 */
function namespaceSpecifier(
  identifier: ts.Identifier,
  main: BoundMainFile,
): string | undefined {
  const symbol = main.checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.declarations?.[0];
  if (symbol === undefined || declaration === undefined) {
    return undefined;
  }

  if (ts.isNamespaceImport(declaration)) {
    return valueImportSpecifier(declaration.parent);
  }

  if (ts.isImportEqualsDeclaration(declaration)) {
    return importEqualsSpecifier(declaration);
  }

  return ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    holdsItsInitializer(declaration, symbol, main)
    ? freeRequireSpecifier(declaration.initializer, main)
    : undefined;
}

/**
 * The source file an import in `containingFile` resolves to, as TypeScript
 * resolves it under the application's tsconfig: `paths` aliases, and a
 * `./root.module.js` specifier naming `root.module.ts`. Undefined for a
 * package's module, or one without code to load.
 */
function resolveImport(
  specifier: string,
  containingFile: string,
  layout: ApplicationLayout,
): string | undefined {
  const options: ts.CompilerOptions = {
    ...layout.tsconfig?.options,
    allowJs: true,
  };
  const host: ts.ModuleResolutionHost = {
    fileExists: (path) => ts.sys.fileExists(path),
    readFile: (path) => ts.sys.readFile(path),
    directoryExists: (path) => ts.sys.directoryExists(path),
    getDirectories: (path) => ts.sys.getDirectories(path),
    realpath: (path) => ts.sys.realpath?.(path) ?? path,
    getCurrentDirectory: () => layout.projectDir,
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
  const { resolvedModule } = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    host,
    undefined,
    undefined,
    ts.getImpliedNodeFormatForFile(containingFile, undefined, host, options),
  );
  if (
    !resolvedModule ||
    resolvedModule.isExternalLibraryImport ||
    UNLOADABLE_EXTENSIONS.has(resolvedModule.extension)
  ) {
    return undefined;
  }

  return resolve(resolvedModule.resolvedFileName);
}
