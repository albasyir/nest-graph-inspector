import { readFileSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { ts } from "ts-morph";
import { CliError, describeError } from "./cli-error";
import { displayPath, isFile } from "./files";
import {
  DEFAULT_OUT_DIR,
  outDirOf,
  type ApplicationBuild,
  type BuildTsConfig,
  type NestApplication,
} from "./nest-cli-config";

/**
 * Finds an application's root module without running any of it: main.ts is
 * parsed, never loaded, and the module it passes to `NestFactory` is traced
 * through its import to a source file, then to the file `nest build` compiled
 * it to. Every file the export loads is checked here first, too, so that
 * nothing that starts the application — main.ts, compiled or bundled — is
 * ever loaded. This file only reads and parses files.
 */

/** The `NestFactory` methods that boot an application from its root module. */
const BOOT_METHODS = new Set([
  "create",
  "createApplicationContext",
  "createMicroservice",
]);

const NEST_FACTORY = "NestFactory";

/** The extensions an application's entry file is looked for with, in this order. */
export const ENTRY_FILE_EXTENSIONS = [
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

type NonEmptyArray<T> = readonly [T, ...T[]];

function isNonEmpty<T>(items: readonly T[]): items is NonEmptyArray<T> {
  return items.length > 0;
}

/** An application, with the tsconfig `nest build` compiles it with. */
export type ApplicationLayout = {
  projectDir: string;
  application: NestApplication;
  tsconfig: BuildTsConfig | undefined;
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
  | { kind: "bundled"; bundler: Bundler };

type Bundler = Extract<ApplicationBuild, { kind: "bundled" }>["bundler"];

/** What main.ts boots, kept to check the export's own choice against once it is made. */
export type ConventionCheck = {
  mainFile: string;
  root: BootedRootModule;
  /** Where `nest build` writes the root module's file. */
  compiled: readonly string[];
};

type ImportBinding =
  | { kind: "export"; specifier: string; exportName: string }
  | { kind: "namespace"; specifier: string };

/** What the names main.ts uses refer to. */
type MainFileScope = {
  imports: ReadonlyMap<string, ImportBinding>;
  /** Classes main.ts declares itself. */
  classes: ReadonlySet<string>;
  /** `const` initializers by name; undefined for a name declared more than once. */
  constants: ReadonlyMap<string, ts.Expression | undefined>;
};

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
 * `.mts`, `.cts`, `.js` — and traces the root module each `NestFactory.create`,
 * `createApplicationContext` or `createMicroservice` call boots to the file
 * that declares it. The file is parsed, never loaded.
 */
export function analyseMainFile(layout: ApplicationLayout): MainFileAnalysis {
  const { application, projectDir } = layout;
  const stem = resolve(projectDir, application.sourceRoot, application.entryFile);
  const mainFile = ENTRY_FILE_EXTENSIONS.map((extension) => stem + extension).find(
    isFile,
  );
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

  const sourceFile = parseSourceFile(mainFile, text);
  const calls = findBootCalls(sourceFile);
  if (!calls.length) {
    return { kind: "unknown", reason: "it calls no NestFactory method" };
  }

  const scope = collectScope(sourceFile);
  let roots: readonly BootedRootModule[] = [];
  for (const argument of calls) {
    const root =
      argument === undefined ? undefined : analyseRootArgument(argument, scope, 0);
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
 * names — by the name its file exports it under, or by the name main.ts
 * imports it as. `--module` naming another export of the only root's file
 * exports that.
 */
export function chooseRootModule(
  analysis: Extract<MainFileAnalysis, { kind: "boots" }>,
  requestedModule: string | undefined,
  cwd: string,
): RootModuleChoice {
  const { roots } = analysis;
  if (requestedModule !== undefined) {
    const match =
      roots.find((root) => root.exportName === requestedModule) ??
      roots.find((root) => root.localName === requestedModule);
    if (match) {
      return { kind: "chosen", root: match, moduleName: match.exportName };
    }

    if (roots.length === 1) {
      return { kind: "chosen", root: roots[0], moduleName: requestedModule };
    }
  } else if (roots.length === 1) {
    return { kind: "chosen", root: roots[0], moduleName: roots[0].exportName };
  }

  const main = displayPath(analysis.mainFile, cwd);
  const names = roots.map(rootName);
  const distinct = new Set(names).size === names.length;
  const listed = distinct
    ? names
    : roots.map((root) => `${rootName(root)} from ${displayPath(root.sourceFile, cwd)}`);
  const boots = `${main} boots ${roots.length} root modules (${listed.join(", ")})`;

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
 * `nest build` compiled the module's source to, found by probing. A bundled one
 * has no such file — its `main.js` holds everything and starts the application
 * — so, like an application not built yet, it is loaded from its TypeScript
 * source when `--require` names a loader, and not at all otherwise.
 */
export function locateRootModule(
  root: BootedRootModule,
  layout: ApplicationLayout,
  hasLoader: boolean,
): RootModuleEntry {
  const { build } = layout.application;
  if (build.kind === "bundled") {
    return hasLoader
      ? { kind: "source", path: root.sourceFile }
      : { kind: "bundled", bundler: build.bundler };
  }

  const candidates = compiledCandidates(root.sourceFile, layout);
  const compiled = candidates.find(isFile);
  if (compiled !== undefined) {
    return { kind: "compiled", path: compiled };
  }

  return hasLoader
    ? { kind: "source", path: root.sourceFile }
    : { kind: "not-built", candidates };
}

/**
 * Where tsc or SWC writes `source`: the outDir, plus the source's path
 * relative to the directory the compiler took as its root. That directory is
 * probed rather than assumed — the tsconfig's `rootDir`, the tsconfig's own
 * directory, the project, the application's `root`, then its `sourceRoot`,
 * which SWC strips — and the candidates are tried in that order.
 */
export function compiledCandidates(
  source: string,
  layout: ApplicationLayout,
): string[] {
  const extension = COMPILED_EXTENSIONS.get(extname(source));
  if (extension === undefined) {
    return [];
  }

  const { application, projectDir, tsconfig } = layout;
  const outDir = outDirOf(projectDir, tsconfig);
  const roots = [
    tsconfig?.options.rootDir,
    tsconfig ? dirname(tsconfig.path) : undefined,
    projectDir,
    resolve(projectDir, application.root),
    resolve(projectDir, application.sourceRoot),
  ];
  const candidates = roots.flatMap((root) => {
    if (root === undefined) {
      return [];
    }

    const path = relative(root, source);
    const outside =
      path === "" || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
    return outside
      ? []
      : [join(outDir, path.slice(0, path.length - extname(path).length) + extension)];
  });

  return [...new Set(candidates)];
}

/**
 * Every path an application's entry file has: its source and what it compiles
 * or bundles to. The export never loads one of them, whatever it contains.
 */
export function applicationEntryFiles(layout: ApplicationLayout): string[] {
  const { application, projectDir, tsconfig } = layout;
  const stem = resolve(projectDir, application.sourceRoot, application.entryFile);
  const sources = ENTRY_FILE_EXTENSIONS.map((extension) => stem + extension);
  const bundle = `${basename(application.entryFile)}.js`;

  return [
    ...sources,
    ...sources.flatMap((source) => compiledCandidates(source, layout)),
    // Where webpack and rspack write main.js: the outDir, and by default
    // dist/ followed by the application's root.
    join(outDirOf(projectDir, tsconfig), bundle),
    join(projectDir, DEFAULT_OUT_DIR, application.root, bundle),
  ];
}

/**
 * Refuses to load a file that would start the application: an application's
 * entry file, by its path, and any file that calls a method of `NestFactory`
 * — main.ts compiled by tsc (`core_1.NestFactory.create(...)`), a webpack
 * bundle (`_nestjs_core__WEBPACK_IMPORTED_MODULE_0__.NestFactory.create(...)`),
 * or one that imports `NestFactory` under another name. Applies to every file
 * the export loads, `--entry` included.
 */
export function assertLoadableEntry(
  path: string,
  applicationEntries: readonly string[],
  cwd: string,
): void {
  const file = displayPath(path, cwd);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new CliError(`Cannot read ${file}: ${describeError(error)}`);
  }

  const call = findNestFactoryCall(parseSourceFile(path, text));
  const target = resolve(path);
  // An entry file can start the application without calling NestFactory
  // itself — through a bootstrap function it imports, say.
  const reason =
    call !== undefined
      ? `it calls ${call}`
      : applicationEntries.some((entry) => resolve(entry) === target)
        ? "it is the application's entry file"
        : undefined;

  if (reason !== undefined) {
    throw new CliError(
      `${file} starts the application (${reason}), so the export will not load it: loading it would run your bootstrap — listen on a port, connect to a database. Point --entry at the file that exports your root module (e.g. dist/app.module.js).`,
    );
  }
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
export function rootName(root: BootedRootModule): string {
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

export function notBuiltMessage(params: {
  mainFile: string;
  root: BootedRootModule;
  candidates: readonly string[];
  command: string;
  cwd: string;
}): string {
  const { mainFile, root, candidates, command, cwd } = params;
  const built = candidates.length
    ? ` to ${candidates.map((path) => displayPath(path, cwd)).join(" or ")}`
    : "";
  return `No compiled ${rootName(root)} found: ${displayPath(mainFile, cwd)} boots it from ${displayPath(root.sourceFile, cwd)}, which has not been built${built}. Build your project first (nest build), or run: ${command}`;
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
  const bundled =
    bundler === "monorepo-default"
      ? `${label} is built into one main.js — nest-cli.json names no builder, and the Nest CLI bundles a monorepo with webpack, or rspack from Nest CLI 12 — which starts the application when it is loaded.`
      : `${label} is built with ${bundler} into one main.js, which starts the application when it is loaded.`;

  return `${bundled} Its root module is ${rootName(root)} in ${displayPath(root.sourceFile, cwd)}. Run: ${command}`;
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
 * `paths`. Never installed or chosen for the user: only suggested.
 */
export function loaderCommand(
  argv: readonly string[],
  tsconfig: BuildTsConfig | undefined,
): string {
  const paths = tsconfig?.options.paths;
  const loaders = [
    "ts-node/register",
    ...(paths && Object.keys(paths).length ? ["tsconfig-paths/register"] : []),
  ];

  return ["nest-graph-inspector", ...argv, ...loaders.flatMap((loader) => ["--require", loader])]
    .map(shellQuote)
    .join(" ");
}

function shellQuote(argument: string): string {
  return /^[\w@%+=:,./-]+$/.test(argument)
    ? argument
    : `'${argument.replace(/'/g, `'\\''`)}'`;
}

/**
 * What main.ts boots, when that is clear — one root module, declared in the
 * file main.ts imports it from — for checking an entry found by convention
 * against. Undefined whenever it is not clear; never throws.
 */
export function conventionCheck(layout: ApplicationLayout): ConventionCheck | undefined {
  try {
    const analysis = analyseMainFile(layout);
    if (analysis.kind !== "boots" || analysis.roots.length !== 1) {
      return undefined;
    }

    const [root] = analysis.roots;
    return declaresClass(root.sourceFile, root.exportName)
      ? {
          mainFile: analysis.mainFile,
          root,
          compiled: compiledCandidates(root.sourceFile, layout),
        }
      : undefined;
  } catch {
    // Only ever a warning: a project the analysis cannot read gets none.
    return undefined;
  }
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
  const sameFile = compiled.some((path) => resolve(path) === resolve(entry.path));

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

/** Whether a file declares the class it exports as `exportName`, rather than re-exporting it. */
function declaresClass(path: string, exportName: string): boolean {
  const sourceFile = parseSourceFile(path, readFileSync(path, "utf8"));

  return sourceFile.statements.some((statement) => {
    if (exportName === "default" && ts.isExportAssignment(statement)) {
      return true;
    }

    if (!ts.isClassDeclaration(statement)) {
      return false;
    }

    return exportName === "default"
      ? (ts.getModifiers(statement) ?? []).some(
          (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
        )
      : statement.name?.text === exportName;
  });
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

/** The first argument of every direct `NestFactory.create`-style call, in source order. */
function findBootCalls(sourceFile: ts.SourceFile): (ts.Expression | undefined)[] {
  const aliases = collectNestFactoryAliases(sourceFile);
  const calls: (ts.Expression | undefined)[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const call = nestFactoryCall(node, aliases);
      if (call?.direct && call.method !== undefined && BOOT_METHODS.has(call.method)) {
        const argument: ts.Expression | undefined = node.arguments[0];
        calls.push(argument);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return calls;
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
 * assigned or destructured from it — or to one of its methods. Scopes are not
 * told apart: a name bound so anywhere counts everywhere in the file.
 */
function collectNestFactoryAliases(sourceFile: ts.SourceFile): NestFactoryAliases {
  const aliases: NestFactoryAliases = { factories: new Set(), methods: new Map() };
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === NEST_FACTORY) {
      aliases.factories.add(node.name.text);
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      collectVariableAlias(node.name, node.initializer, aliases);
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

/** What main.ts's names refer to: its imports, the classes it declares, its constants. */
function collectScope(sourceFile: ts.SourceFile): MainFileScope {
  const imports = new Map<string, ImportBinding>();
  const classes = new Set<string>();
  const constants = new Map<string, ts.Expression | undefined>();

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      collectImport(node, imports);
      return;
    }

    if (ts.isImportEqualsDeclaration(node)) {
      // import mods = require("./root.module");
      const reference = node.moduleReference;
      if (
        !node.isTypeOnly &&
        ts.isExternalModuleReference(reference) &&
        ts.isStringLiteralLike(reference.expression)
      ) {
        imports.set(node.name.text, {
          kind: "namespace",
          specifier: reference.expression.text,
        });
      }
      return;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      classes.add(node.name.text);
    }

    if (
      ts.isVariableDeclarationList(node) &&
      node.flags & ts.NodeFlags.Const
    ) {
      for (const declaration of node.declarations) {
        collectConstant(declaration, imports, constants);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { imports, classes, constants };
}

function collectImport(
  node: ts.ImportDeclaration,
  imports: Map<string, ImportBinding>,
): void {
  const clause = node.importClause;
  if (
    !clause ||
    clause.phaseModifier === ts.SyntaxKind.TypeKeyword ||
    !ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    return;
  }

  const specifier = node.moduleSpecifier.text;
  if (clause.name) {
    imports.set(clause.name.text, {
      kind: "export",
      specifier,
      exportName: "default",
    });
  }

  const bindings = clause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) {
    imports.set(bindings.name.text, { kind: "namespace", specifier });
  } else if (bindings) {
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) {
        imports.set(element.name.text, {
          kind: "export",
          specifier,
          exportName: (element.propertyName ?? element.name).text,
        });
      }
    }
  }
}

/** `const` declarations: `require()` calls are imports, anything else a constant. */
function collectConstant(
  declaration: ts.VariableDeclaration,
  imports: Map<string, ImportBinding>,
  constants: Map<string, ts.Expression | undefined>,
): void {
  const initializer = declaration.initializer;
  if (!initializer) {
    return;
  }

  const required = requireSpecifier(initializer);
  if (ts.isIdentifier(declaration.name)) {
    const name = declaration.name.text;
    const value = unwrap(initializer);
    const requiredFrom = ts.isPropertyAccessExpression(value)
      ? requireSpecifier(value.expression)
      : undefined;
    if (required !== undefined) {
      // const mods = require("./root.module");
      imports.set(name, { kind: "namespace", specifier: required });
    } else if (requiredFrom !== undefined && ts.isPropertyAccessExpression(value)) {
      // const RootModule = require("./root.module").RootModule;
      imports.set(name, {
        kind: "export",
        specifier: requiredFrom,
        exportName: value.name.text,
      });
    } else {
      constants.set(name, constants.has(name) ? undefined : initializer);
    }
    return;
  }

  // const { RootModule } = require("./root.module");
  if (ts.isObjectBindingPattern(declaration.name) && required !== undefined) {
    for (const element of declaration.name.elements) {
      if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
        continue;
      }

      const exportName = element.propertyName
        ? propertyNameText(element.propertyName)
        : element.name.text;
      if (exportName !== undefined) {
        imports.set(element.name.text, {
          kind: "export",
          specifier: required,
          exportName,
        });
      }
    }
  }
}

/** `require("x")` → `x`. */
function requireSpecifier(expression: ts.Expression): string | undefined {
  const call = unwrap(expression);
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    call.expression.text !== "require" ||
    call.arguments.length !== 1
  ) {
    return undefined;
  }

  const specifier = call.arguments[0];
  return ts.isStringLiteralLike(specifier) ? specifier.text : undefined;
}

/**
 * What the first argument of a `NestFactory` call refers to: an imported
 * class — `RootModule`, `mods.RootModule`, `RootModule.forRoot(...)` — a class
 * main.ts declares itself, or something only known at runtime.
 */
function analyseRootArgument(
  argument: ts.Expression,
  scope: MainFileScope,
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

    const target = analyseModuleReference(callee.expression, scope, depth);
    return target.kind === "imported"
      ? { ...target, dynamicMethod: callee.name.text }
      : target;
  }

  return analyseModuleReference(expression, scope, depth);
}

function analyseModuleReference(
  expression: ts.Expression,
  scope: MainFileScope,
  depth: number,
): RootArgument {
  const reference = unwrap(expression);
  if (ts.isIdentifier(reference)) {
    const name = reference.text;
    const binding = scope.imports.get(name);
    if (binding?.kind === "export") {
      return {
        kind: "imported",
        specifier: binding.specifier,
        exportName: binding.exportName,
        localName: name,
        dynamicMethod: undefined,
      };
    }

    if (scope.classes.has(name)) {
      return { kind: "declared", name };
    }

    const initializer = scope.constants.get(name);
    if (initializer !== undefined && ts.isClassExpression(unwrap(initializer))) {
      return { kind: "declared", name };
    }

    return initializer !== undefined && depth < MAX_CONSTANT_DEPTH
      ? analyseRootArgument(initializer, scope, depth + 1)
      : { kind: "unknown" };
  }

  if (ts.isPropertyAccessExpression(reference)) {
    // mods.RootModule, from import * as mods, or require("./root.module").RootModule
    const object = unwrap(reference.expression);
    const binding = ts.isIdentifier(object) ? scope.imports.get(object.text) : undefined;
    const specifier =
      binding?.kind === "namespace" ? binding.specifier : requireSpecifier(object);
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
