import { readFileSync } from "node:fs";
import { ts } from "ts-morph";
import { compiledCandidates, pickCompiled, sharedWith } from "./build-output";
import { displayPath, joinedPaths, samePath } from "./files";
import type { ApplicationLayout } from "./nest-cli-config";
import {
  MAX_CONSTANT_DEPTH,
  analyseMainFile,
  forRootWarning,
  resolveImport,
  rootName,
  type BootedRootModule,
} from "./root-module-detection";
import { parseSourceFile, unwrap } from "./source-syntax";

/**
 * Checks an entry the `app.module.js` convention found against what main.ts
 * boots, for a warning only: main.ts's import is followed through static
 * re-exports to the file that declares the class, read as JavaScript reads
 * them — an explicit export of a name hides any `export *` that has it too.
 */

/** How many files of re-exports are followed from main.ts's import to the class. */
const MAX_REEXPORT_DEPTH = 3;

export type ConventionCheck = {
  mainFile: string;
  root: BootedRootModule;
  /** Where `nest build` writes the root module's file. */
  compiled: readonly string[];
  /** The project's other applications, whose builds could write the same file. */
  others: readonly ApplicationLayout[];
};

/** What main.ts boots, when that is one root module traced to its class's file; never throws. */
export function conventionCheck(
  layout: ApplicationLayout,
  others: readonly ApplicationLayout[],
): ConventionCheck | undefined {
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
    return { mainFile: analysis.mainFile, root, compiled: compiledCandidates(root.sourceFile, layout), others };
  } catch {
    // Only ever a warning: a project the analysis cannot read gets none.
    return undefined;
  }
}

/**
 * Once the root module export is chosen: a warning when main.ts boots a
 * module from another file, or another export of the same file, and when it
 * boots the same one through `.forRoot()`, whose options the export goes
 * without.
 */
export function conventionWarnings(
  check: ConventionCheck,
  entry: { path: string; moduleName: string; requestedModule: string | undefined },
  cwd: string,
): string[] {
  const { mainFile, root, compiled } = check;
  const name = rootName(root);
  const boots = `${displayPath(mainFile, cwd)} boots ${name} from ${displayPath(root.sourceFile, cwd)}, but the export uses ${displayPath(entry.path, cwd)} (${entry.moduleName}) by convention.`;

  if (!compiled.some((path) => samePath(path, entry.path))) {
    return [`${boots} ${entryAdvice(check, name, cwd)}`];
  }

  if (entry.moduleName !== root.exportName) {
    return entry.requestedModule === undefined
      ? [`${boots} Pass --module ${root.exportName} to export ${name}.`]
      : [];
  }

  const forRoot = forRootWarning(mainFile, root, cwd);
  return forRoot === undefined ? [] : [forRoot];
}

/** A compiled file to pass as `--entry` only when there is one and it is plainly this build's, as the export itself would take it. */
function entryAdvice({ root, compiled, others }: ConventionCheck, name: string, cwd: string): string {
  const fromSource = `pass --entry ${displayPath(root.sourceFile, cwd)} --module ${root.exportName} --require ts-node/register to export ${name}`;
  const built = pickCompiled(compiled);
  if (built.kind === "missing") {
    return `Pass --entry/--module to export ${name}.`;
  }

  if (built.kind === "several") {
    return `${name} has been built to ${joinedPaths(built.paths, cwd)}, and which is current cannot be told: build again into an emptied outDir, or ${fromSource}.`;
  }

  const path = displayPath(built.path, cwd);
  const otherSource = sharedWith(built.path, root.sourceFile, others);
  return otherSource === undefined
    ? `Pass --entry ${path} --module ${root.exportName} to export ${name}.`
    : `${name} is built to ${path} — but another application's ${displayPath(otherSource, cwd)} builds to ${path} too, so whose it is cannot be told: give each application an outDir of its own, or ${fromSource}.`;
}

/**
 * The file that declares the class a module exports as `exportName`, and its
 * name there. A file is never entered twice for the same name on one trail,
 * so a cycle ends, while a sibling `export *` may still look in it for
 * another name. Undefined when the trail leads nowhere it can read.
 */
function declaringExport(lookup: {
  file: string;
  exportName: string;
  layout: ApplicationLayout;
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
  | { kind: "declared" }
  | { kind: "reexported"; specifier: string; name: string }
  /** Nothing a class can be traced through: a namespace, a function, a value. */
  | { kind: "opaque" };

function explicitExport(sourceFile: ts.SourceFile, exportName: string): ExplicitExport | undefined {
  const imports = importedBindings(sourceFile);
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      if (exportName !== "default") {
        continue;
      }

      const value = unwrap(statement.expression);
      return (ts.isIdentifier(value) ? moduleBinding(sourceFile, value.text, imports, 0) : undefined) ?? {
        kind: "declared",
      };
    }

    if (ts.isClassDeclaration(statement) && exportsDeclarationAs(statement, exportName)) {
      return { kind: "declared" };
    }

    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      // export const RootModule = AppModule: this name, whatever an export *
      // has — traced through a plain alias, and no further.
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
      exportsDeclarationAs(statement, exportName)
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

    return moduleBinding(sourceFile, local, imports, 0) ?? { kind: "opaque" };
  }

  return undefined;
}

/** A top-level name, to export: a class declared there, an import, or — through `const X = Y` — what `Y` is. */
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
 * A class expression, or what a `const` set to a plain name holds. `list` is
 * passed in because a file parsed without parent links cannot reach it.
 */
function constantExport(
  declaration: ts.VariableDeclaration,
  list: ts.VariableDeclarationList,
  sourceFile: ts.SourceFile,
  imports: ReadonlyMap<string, ExplicitExport>,
  depth: number,
): ExplicitExport {
  const value = declaration.initializer === undefined ? undefined : unwrap(declaration.initializer);
  if (value === undefined || (list.flags & ts.NodeFlags.Const) === 0 || depth >= MAX_CONSTANT_DEPTH) {
    return { kind: "opaque" };
  }

  if (ts.isClassExpression(value)) {
    return { kind: "declared" };
  }

  return ts.isIdentifier(value)
    ? (moduleBinding(sourceFile, value.text, imports, depth + 1) ?? { kind: "opaque" })
    : { kind: "opaque" };
}

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

/** `export default class X` and `export default function X` export `default`, never `X`. */
function exportsDeclarationAs(
  statement: ts.ClassDeclaration | ts.FunctionDeclaration | ts.EnumDeclaration,
  exportName: string,
): boolean {
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
    return false;
  }

  const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
  return exportName === "default" ? isDefault : !isDefault && statement.name?.text === exportName;
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
