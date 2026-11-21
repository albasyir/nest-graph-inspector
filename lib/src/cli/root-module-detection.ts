import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ts } from "ts-morph";
import {
  buildAdvice,
  bundleFileName,
  compiledCandidates,
  entryFileSources,
  pickCompiled,
  sharedWith,
  staleBuildsReason,
} from "./build-output";
import { CliError } from "./cli-error";
import { displayPath, isFile, joinedPaths, pathInside, samePath } from "./files";
import type { ApplicationBuild, ApplicationLayout } from "./nest-cli-config";
import {
  NEST_CORE,
  NEST_FACTORY,
  factoryCalls,
  memberOf,
  propertyNameText,
  readFactoryReference,
  scriptKindOf,
  unwrap,
  type FactoryReading,
  type FactoryReference,
} from "./source-syntax";

/**
 * Finds the root module main.ts boots without running any of it: main.ts is
 * parsed, the module it passes to `@nestjs/core`'s `NestFactory` is traced
 * through its import to a source file, and from there to the file `nest
 * build` compiled it to.
 */

const BOOT_METHODS = new Set(["create", "createApplicationContext", "createMicroservice"]);

/** Resolved files that hold no code the export could load. */
const UNLOADABLE_EXTENSIONS = new Set<string>([
  ts.Extension.Dts,
  ts.Extension.Dmts,
  ts.Extension.Dcts,
  ts.Extension.Json,
]);

/** How many `const` aliases a root module, or an `export const` of one, is followed through. */
export const MAX_CONSTANT_DEPTH = 3;

/** How many declarations a name is followed through to `@nestjs/core`. */
const MAX_ALIAS_DEPTH = 5;

/** How many characters of a passed-over call a note quotes. */
const MAX_QUOTED_CALL = 80;

export type BootedRootModule = {
  /** `default` for a default export. */
  exportName: string;
  /** What main.ts calls it: the imported name, a `const` holding it, or `mods.RootModule`. */
  localName: string;
  sourceFile: string;
  /** For `RootModule.forRoot(...)`: `forRoot`. */
  dynamicMethod: string | undefined;
};

/** A `NestFactory` call whose root module the export cannot follow, passed over while another decides. */
type SkippedBoot = { line: number; call: string };

type MainFileAnalysis =
  | {
      kind: "boots";
      mainFile: string;
      /** Each once, in the order main.ts boots them. */
      roots: readonly [BootedRootModule, ...BootedRootModule[]];
      skipped: readonly SkippedBoot[];
    }
  /** Loading main.ts would start the application. */
  | { kind: "declares-root"; mainFile: string; name: string }
  | { kind: "unknown" };

/** main.ts, bound: the checker finds the declaration each name in it refers to. */
type BoundMainFile = { sourceFile: ts.SourceFile; checker: ts.TypeChecker };

/** A module main.ts takes a root module from: as an `import`, or as a `require`. */
type ModuleImport = { specifier: string; resolution: "import" | "require" };

type RootArgument =
  | ({ kind: "imported"; exportName: string; localName: string; dynamicMethod: string | undefined } & ModuleImport)
  | { kind: "declared"; name: string }
  | { kind: "unknown" };

type MainFileRequest = {
  layout: ApplicationLayout;
  /** The project's other applications, whose builds could write the same file. */
  others: readonly ApplicationLayout[];
  /** `--module`. */
  module: string | undefined;
  hasLoader: boolean;
  /** The command line the message suggests running again, with a loader. */
  argv: readonly string[];
  app: string | undefined;
  cwd: string;
};

/** The root module main.ts boots, and the file to load it from, which the load guard has still to check. */
type MainFileEntry = {
  file: string;
  moduleName: string;
  mainFile: string;
  /** Notes on the boots passed over. */
  skipped: readonly string[];
  warnings: readonly string[];
};

/**
 * The root module main.ts boots — the only one, or the one `--module` names —
 * and the file to load it from. Undefined when main.ts boots none the export
 * can follow; throws, saying why and what to run, when it boots one the
 * export must not or cannot load.
 */
export function entryFromMainFile(request: MainFileRequest): MainFileEntry | undefined {
  const { layout, cwd } = request;
  const analysis = analyseMainFile(layout);
  if (analysis.kind === "unknown") {
    return undefined;
  }

  const { mainFile } = analysis;
  const main = displayPath(mainFile, cwd);
  if (analysis.kind === "declares-root") {
    const { name } = analysis;
    throw new CliError(
      `${main} declares its root module ${name} itself, and loading ${main} would start the application, so the export will not load it. Move ${name} into a file of its own that ${main} imports, or pass --entry with a file that exports your root module and does not start the application.`,
    );
  }

  const { root, moduleName } = chooseRootModule(analysis, request.module, cwd);
  const file = locateRootModule({ ...request, root, mainFile });
  const forRoot = moduleName === root.exportName ? forRootWarning(mainFile, root, cwd) : undefined;
  return {
    file,
    moduleName,
    mainFile,
    skipped: analysis.skipped.map(
      ({ line, call }) =>
        `skipped ${main}:${line} ${call}: its root module is not an import the export can follow`,
    ),
    warnings: forRoot === undefined ? [] : [forRoot],
  };
}

export function analyseMainFile(layout: ApplicationLayout): MainFileAnalysis {
  const mainFile = entryFileSources(layout).find(isFile);
  if (!mainFile) {
    return { kind: "unknown" };
  }

  let text: string;
  try {
    text = readFileSync(mainFile, "utf8");
  } catch {
    return { kind: "unknown" };
  }

  const main = parseWithScopes(mainFile, text);
  const calls = findBootCalls(main);
  if (!calls.length) {
    return { kind: "unknown" };
  }

  let roots: readonly BootedRootModule[] = [];
  const skipped: SkippedBoot[] = [];
  for (const call of calls) {
    const argument: ts.Expression | undefined = call.arguments[0];
    const root = argument === undefined ? undefined : analyseRootArgument(argument, main, 0);
    if (root?.kind === "declared") {
      return { kind: "declares-root", mainFile, name: root.name };
    }

    const sourceFile =
      root?.kind === "imported"
        ? resolveImport(root.specifier, mainFile, layout, root.resolution)
        : undefined;
    // Only known at runtime, or from a package: what can be followed decides.
    if (root?.kind !== "imported" || sourceFile === undefined) {
      skipped.push(skippedBoot(call, main.sourceFile));
      continue;
    }

    roots = withRoot(roots, {
      exportName: root.exportName,
      localName: root.localName,
      sourceFile,
      dynamicMethod: root.dynamicMethod,
    });
  }

  const [first, ...rest] = roots;
  return first === undefined
    ? { kind: "unknown" }
    : { kind: "boots", mainFile, roots: [first, ...rest], skipped };
}

function skippedBoot(call: ts.CallExpression, sourceFile: ts.SourceFile): SkippedBoot {
  const { line } = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  // On one line, as a formatter would put it: `create(\n  Root,\n)` is `create(Root)`.
  const text = call
    .getText(sourceFile)
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/,? \)/g, ")");
  return {
    line: line + 1,
    call: text.length > MAX_QUOTED_CALL ? `${text.slice(0, MAX_QUOTED_CALL - 1)}…` : text,
  };
}

/** Each root module once, by file and export; a `.forRoot()` on any boot of it marks it. */
function withRoot(
  roots: readonly BootedRootModule[],
  root: BootedRootModule,
): readonly BootedRootModule[] {
  const known = roots.find(
    (candidate) =>
      candidate.sourceFile === root.sourceFile && candidate.exportName === root.exportName,
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
 * The only root module main.ts boots, or the one `--module` names: by export
 * name, else by main.ts's name for it. A name that matches several — one
 * export name from two files — chooses none, and throws, as several root
 * modules and no name do. `--module` naming another export of the only root's
 * file exports that.
 */
function chooseRootModule(
  analysis: Extract<MainFileAnalysis, { kind: "boots" }>,
  requestedModule: string | undefined,
  cwd: string,
): { root: BootedRootModule; moduleName: string } {
  const { roots } = analysis;
  const main = displayPath(analysis.mainFile, cwd);
  const listed = (candidates: readonly BootedRootModule[]) => {
    const names = candidates.map(rootName);
    return new Set(names).size === names.length
      ? names
      : candidates.map((root) => `${rootName(root)} from ${displayPath(root.sourceFile, cwd)}`);
  };

  if (requestedModule !== undefined) {
    const byExport = roots.filter((root) => root.exportName === requestedModule);
    const matches = byExport.length
      ? byExport
      : roots.filter((root) => root.localName === requestedModule);
    const [match, ...others] = matches;
    if (match !== undefined && !others.length) {
      return { root: match, moduleName: match.exportName };
    }

    if (match !== undefined) {
      throw new CliError(
        `${main} boots ${matches.length} root modules named ${requestedModule} (${listed(matches).join(", ")}). Pass --entry <file> and --module ${requestedModule} for the one to export.`,
      );
    }

    if (roots.length === 1) {
      return { root: roots[0], moduleName: requestedModule };
    }
  } else if (roots.length === 1) {
    return { root: roots[0], moduleName: roots[0].exportName };
  }

  const plainNames = roots.map(rootName);
  const distinct = new Set(plainNames).size === plainNames.length;
  const boots = `${main} boots ${roots.length} root modules (${listed(roots).join(", ")})`;

  throw new CliError(
    requestedModule === undefined
      ? `${boots}. ${distinct ? "Pass --module <name>." : "Pass --entry <file> and --module <name>."}`
      : `${boots}, and none of them is ${requestedModule}. Pass --module with one of them, or --entry <file> and --module <name>.`,
  );
}

type Located =
  | { kind: "load"; path: string }
  | { kind: "not-built"; candidates: readonly string[] }
  | { kind: "bundled"; bundler: Extract<ApplicationBuild, { kind: "bundled" }>["bundler"] }
  | { kind: "several"; paths: readonly string[] }
  /** Another application's build writes the same file, from a source of its own. */
  | { kind: "shared"; path: string; otherSource: string };

type LocateRequest = MainFileRequest & { root: BootedRootModule; mainFile: string };

/**
 * The file to load for the root module: the one file `nest build` compiled
 * its source to, when that is plainly this build's — otherwise, given a
 * `--require` loader, its TypeScript source. A bundle has no such file: its
 * one `main.js` starts the application. Throws, saying why and what to run,
 * when there is nothing to load.
 */
function locateRootModule(request: LocateRequest): string {
  const located = locate(request);
  if (located.kind === "load") {
    return located.path;
  }

  throw new CliError(unlocatedMessage(located, request));
}

function locate({ root, layout, others, hasLoader }: LocateRequest): Located {
  const { build } = layout.application;
  const source: Located = { kind: "load", path: root.sourceFile };
  if (build.kind === "bundled") {
    return hasLoader ? source : { kind: "bundled", bundler: build.bundler };
  }

  const candidates = compiledCandidates(root.sourceFile, layout);
  const compiled = pickCompiled(candidates);
  switch (compiled.kind) {
    case "missing":
      return hasLoader ? source : { kind: "not-built", candidates };
    case "several":
      return hasLoader ? source : compiled;
    case "found": {
      const otherSource = sharedWith(compiled.path, root.sourceFile, others);
      if (otherSource === undefined) {
        return { kind: "load", path: compiled.path };
      }

      return hasLoader ? source : { kind: "shared", path: compiled.path, otherSource };
    }
    default: {
      const _exhaustive: never = compiled;
      return _exhaustive;
    }
  }
}

function unlocatedMessage(
  located: Exclude<Located, { kind: "load" }>,
  { root, mainFile, layout, argv, app, cwd }: LocateRequest,
): string {
  const { application } = layout;
  const command = loaderCommand(argv, layout);
  const boots = `${displayPath(mainFile, cwd)} boots ${rootName(root)} from ${displayPath(root.sourceFile, cwd)}`;
  switch (located.kind) {
    case "not-built": {
      const built = located.candidates.length
        ? ` to ${located.candidates.map((path) => displayPath(path, cwd)).join(" or ")}`
        : "";
      return `No compiled ${rootName(root)} found: ${displayPath(mainFile, cwd)} boots it from ${displayPath(root.sourceFile, cwd)}, which has not been built${built}. ${buildAdvice(app)}, or run: ${command}`;
    }
    case "bundled":
      return `${application.root || application.name || "The project"} is built with ${located.bundler} into one ${bundleFileName(application)}, which starts the application when it is loaded. Its root module is ${rootName(root)} in ${displayPath(root.sourceFile, cwd)}. Run: ${command}`;
    case "several": {
      const files = joinedPaths(located.paths, cwd);
      const built =
        application.build.kind === "swc"
          ? `which SWC has built to both ${files}`
          : `which has been built to ${files}`;
      return `${boots}, ${built}: ${staleBuildsReason(application.build)}. Pass --entry with the current one, build again into an emptied outDir, or run: ${command}`;
    }
    case "shared": {
      const compiled = displayPath(located.path, cwd);
      return `${boots}, built to ${compiled} — but another application's ${displayPath(located.otherSource, cwd)} builds to ${compiled} too, so whose it is cannot be told. Pass --entry with the file to load, or load the TypeScript source: ${command}`;
    }
    default: {
      const _exhaustive: never = located;
      return _exhaustive;
    }
  }
}

/** The root module's name as a user knows it: main.ts's name for a default export. */
export function rootName(root: BootedRootModule): string {
  return root.exportName === "default" ? root.localName : root.exportName;
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
 * The command line as given, with the loaders loading the TypeScript source
 * needs — ts-node, which emits the decorator metadata Nest reads, and
 * tsconfig-paths when the tsconfig maps `paths`. Both read the project's
 * `tsconfig.json` unless `TS_NODE_PROJECT` names another, so the command sets
 * it for an application built with another tsconfig. Only ever suggested.
 */
function loaderCommand(argv: readonly string[], layout: ApplicationLayout): string {
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
  return /^[\w@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`;
}

/**
 * main.ts as a program of its own, for the checker to tell which declaration
 * each name refers to, scope by scope. No import is resolved and no lib is
 * loaded: only the declarations main.ts itself makes are known.
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

  return { sourceFile: program.getSourceFile(path) ?? parsed, checker: program.getTypeChecker() };
}

/**
 * The calls that boot an application, through the `NestFactory` main.ts
 * takes from `@nestjs/core` alone: an object of its own that shares the name,
 * or a parameter or local that shadows the import, boots nothing.
 */
function findBootCalls(main: BoundMainFile): ts.CallExpression[] {
  return factoryCalls(main.sourceFile, strictly(main, 0))
    .filter(({ method }) => method !== undefined && BOOT_METHODS.has(method))
    .map(({ call }) => call);
}

function strictly(main: BoundMainFile, depth: number): FactoryReading {
  return {
    lenient: false,
    base: (base) =>
      isCoreModuleCall(base, main)
        ? { kind: "module" }
        : ts.isIdentifier(base)
          ? declaredReference(main.checker.getSymbolAtLocation(base), main, depth)
          : undefined,
  };
}

function coreReference(
  expression: ts.Expression,
  main: BoundMainFile,
  depth: number,
): FactoryReference | undefined {
  return depth > MAX_ALIAS_DEPTH ? undefined : readFactoryReference(expression, strictly(main, depth));
}

/**
 * What a name's declaration binds it to of `@nestjs/core`: an import of the
 * package or of its `NestFactory`, or a variable that still holds one. A
 * parameter, a catch clause's variable, a function or a class binds nothing.
 */
function declaredReference(
  symbol: ts.Symbol | undefined,
  main: BoundMainFile,
  depth: number,
): FactoryReference | undefined {
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
    return valueImportSpecifier(declaration.parent) === NEST_CORE ? { kind: "module" } : undefined;
  }

  if (ts.isImportClause(declaration)) {
    // import core from "@nestjs/core": the CommonJS module itself.
    return valueImportSpecifier(declaration) === NEST_CORE ? { kind: "module" } : undefined;
  }

  if (ts.isImportEqualsDeclaration(declaration)) {
    return importEqualsSpecifier(declaration) === NEST_CORE ? { kind: "module" } : undefined;
  }

  if (ts.isVariableDeclaration(declaration)) {
    return declaration.initializer === undefined || !holdsItsInitializer(declaration, symbol, main)
      ? undefined
      : coreReference(declaration.initializer, main, depth + 1);
  }

  // const { NestFactory } = require("@nestjs/core"); const { create } = NestFactory;
  const destructured = destructuredFrom(declaration, symbol, main);
  return destructured === undefined
    ? undefined
    : memberOf(coreReference(destructured.initializer, main, depth + 1), destructured.property, false);
}

function valueImportSpecifier(clause: ts.ImportClause): string | undefined {
  const { moduleSpecifier } = clause.parent;
  return clause.phaseModifier !== ts.SyntaxKind.TypeKeyword && ts.isStringLiteralLike(moduleSpecifier)
    ? moduleSpecifier.text
    : undefined;
}

function importEqualsSpecifier(declaration: ts.ImportEqualsDeclaration): string | undefined {
  const reference = declaration.moduleReference;
  return !declaration.isTypeOnly &&
    ts.isExternalModuleReference(reference) &&
    ts.isStringLiteralLike(reference.expression)
    ? reference.expression.text
    : undefined;
}

/** `const { X: Y } = …`: the initializer and the property, while `Y` still holds it. */
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
 * A `const`, or a `let` or `var` declared once and never assigned again: only
 * then does following its initializer tell what it refers to.
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

/** The left of an assignment, directly or inside a destructuring one, `++`/`--`, or a `for … in/of` variable. */
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

/** `require("x")` → `x`, when `require` is CommonJS's own rather than a name main.ts declares. */
function freeRequireSpecifier(expression: ts.Expression, main: BoundMainFile): string | undefined {
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
 * What the first argument of a `NestFactory` call refers to: an imported
 * class — `RootModule`, `mods.RootModule`, `RootModule.forRoot(...)` — a class
 * main.ts declares itself, or something only known at runtime.
 */
function analyseRootArgument(argument: ts.Expression, main: BoundMainFile, depth: number): RootArgument {
  const expression = unwrap(argument);
  if (ts.isCallExpression(expression)) {
    // RootModule.forRoot(...): a dynamic module of RootModule, whose options
    // only exist at runtime.
    const callee = unwrap(expression.expression);
    if (!ts.isPropertyAccessExpression(callee)) {
      return { kind: "unknown" };
    }

    const target = analyseModuleReference(callee.expression, main, depth);
    return target.kind === "imported" ? { ...target, dynamicMethod: callee.name.text } : target;
  }

  return analyseModuleReference(expression, main, depth);
}

function analyseModuleReference(expression: ts.Expression, main: BoundMainFile, depth: number): RootArgument {
  const reference = unwrap(expression);
  if (ts.isIdentifier(reference)) {
    return nameReference(reference, main, depth);
  }

  if (ts.isPropertyAccessExpression(reference)) {
    // mods.RootModule, from import * as mods, or require("./root.module").RootModule
    const object = unwrap(reference.expression);
    const namespace = ts.isIdentifier(object)
      ? namespaceSpecifier(object, main)
      : requiredModule(object, main);
    if (namespace !== undefined) {
      return {
        kind: "imported",
        ...namespace,
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

function requiredModule(expression: ts.Expression, main: BoundMainFile): ModuleImport | undefined {
  const specifier = freeRequireSpecifier(expression, main);
  return specifier === undefined ? undefined : { specifier, resolution: "require" };
}

/**
 * What a name passed to `NestFactory` refers to, by the declaration the
 * checker finds in its own scope — so a local that shadows an import is the
 * local. A variable is followed to what it was declared with while it still
 * holds that, and keeps its own name for main.ts's (`const Worker =
 * WorkerModule`), so `--module` can choose by either.
 */
function nameReference(identifier: ts.Identifier, main: BoundMainFile, depth: number): RootArgument {
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
    const required = requiredModule(destructured.initializer, main);
    return required === undefined || destructured.property === undefined
      ? { kind: "unknown" }
      : {
          kind: "imported",
          ...required,
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

  if (depth >= MAX_CONSTANT_DEPTH) {
    return { kind: "unknown" };
  }

  const held = analyseRootArgument(declaration.initializer, main, depth + 1);
  // One holding RootModule.forRoot(...) holds a dynamic module, not the
  // class, and keeps the class's name for the warning that names the call.
  return held.kind === "imported" && held.dynamicMethod === undefined
    ? { ...held, localName: name }
    : held;
}

function importedExport(declaration: ts.Declaration): (ModuleImport & { exportName: string }) | undefined {
  if (ts.isImportSpecifier(declaration)) {
    const specifier = valueImportSpecifier(declaration.parent.parent);
    return declaration.isTypeOnly || specifier === undefined
      ? undefined
      : {
          specifier,
          resolution: "import",
          exportName: (declaration.propertyName ?? declaration.name).text,
        };
  }

  if (ts.isImportClause(declaration)) {
    const specifier = valueImportSpecifier(declaration);
    return specifier === undefined ? undefined : { specifier, resolution: "import", exportName: "default" };
  }

  return undefined;
}

/** `import * as mods from`, `import mods = require()`, or `const mods = require()` while it holds that. */
function namespaceSpecifier(identifier: ts.Identifier, main: BoundMainFile): ModuleImport | undefined {
  const symbol = main.checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.declarations?.[0];
  if (symbol === undefined || declaration === undefined) {
    return undefined;
  }

  const imported = (specifier: string | undefined, resolution: ModuleImport["resolution"]) =>
    specifier === undefined ? undefined : { specifier, resolution };

  if (ts.isNamespaceImport(declaration)) {
    return imported(valueImportSpecifier(declaration.parent), "import");
  }

  if (ts.isImportEqualsDeclaration(declaration)) {
    return imported(importEqualsSpecifier(declaration), "require");
  }

  return ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    holdsItsInitializer(declaration, symbol, main)
    ? requiredModule(declaration.initializer, main)
    : undefined;
}

/**
 * The source file an import resolves to, as TypeScript resolves it under the
 * application's tsconfig — `paths`, and `./root.module.js` naming
 * `root.module.ts`. An `import` resolves in the mode the file's own format
 * gives it, ESM's for an `.mts` file under `node16`/`nodenext`; a `require` —
 * `import x = require()`, `require()` — always in CommonJS's, as the compiler
 * does. Undefined for a package's module, or one without code to load.
 */
export function resolveImport(
  specifier: string,
  containingFile: string,
  layout: ApplicationLayout,
  resolution: ModuleImport["resolution"] = "import",
): string | undefined {
  const options: ts.CompilerOptions = { ...layout.tsconfig?.options, allowJs: true };
  const host: ts.ModuleResolutionHost = { ...ts.sys, getCurrentDirectory: () => layout.projectDir };
  const { resolvedModule } = ts.resolveModuleName(
    specifier,
    containingFile,
    options,
    host,
    undefined,
    undefined,
    resolution === "require"
      ? ts.ModuleKind.CommonJS
      : ts.getImpliedNodeFormatForFile(containingFile, undefined, host, options),
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
