import { readFileSync, realpathSync } from "node:fs";
import { ts } from "ts-morph";
import { applicationEntryFiles } from "./build-output";
import { CliError, describeError } from "./cli-error";
import { displayPath, samePath } from "./files";
import { readEveryLayout, readNestCliConfigOrDefaults } from "./nest-cli-config";
import {
  NEST_FACTORY,
  factoryCalls,
  memberOf,
  parseSourceFile,
  propertyNameText,
  readFactoryReference,
  unwrap,
  type FactoryReading,
  type FactoryReference,
} from "./source-syntax";

/**
 * The export's trust boundary: the one file it is about to load — `--entry`'s,
 * the convention's, or the one found from main.ts — is refused when it would
 * start the application. Only that file is checked: the modules it imports
 * load with it, unread, so a root module file that imports main.ts, or a file
 * that boots the application, still starts it. Checking them would mean
 * resolving the application's whole import graph as Node does.
 */

declare const loadable: unique symbol;

/** A file `assertLoadableEntry` let through, symlinks resolved: the only kind the export loads. */
export type LoadableFile = string & { readonly [loadable]: true };

/**
 * Refuses the file when it calls a method of any `NestFactory`, or is the
 * entry file of any application nest-cli.json defines — which can start the
 * application through a function it imports. nest-cli.json is read here, not
 * taken from the caller, so no caller can leave an application out; one that
 * cannot be read is taken as absent, which only `--entry` meets — every other
 * way to the entry has read it already.
 */
export function assertLoadableEntry(
  path: string,
  { projectDir, cwd }: { projectDir: string; cwd: string },
): LoadableFile {
  const file = displayPath(path, cwd);
  let checked: string;
  let text: string;
  try {
    checked = realpathSync(path);
    text = readFileSync(checked, "utf8");
  } catch (error) {
    throw new CliError(`Cannot read ${file}: ${describeError(error)}`);
  }

  const call = findNestFactoryCall(parseSourceFile(checked, text));
  const reason =
    call !== undefined
      ? `it calls ${call}`
      : readEveryLayout(projectDir, readNestCliConfigOrDefaults(projectDir), cwd)
            .flatMap(applicationEntryFiles)
            .some((entry) => samePath(entry, checked))
        ? "it is the application's entry file"
        : undefined;
  if (reason !== undefined) {
    throw new CliError(
      `${file} starts the application (${reason}), so the export will not load it: loading it would run your bootstrap — listen on a port, connect to a database. Point --entry at the file that exports your root module (e.g. dist/app.module.js).`,
    );
  }

  // The one place a LoadableFile is made.
  return checked as LoadableFile;
}

const MODULE: FactoryReference = { kind: "module" };
const FACTORY: FactoryReference = { kind: "factory" };

/**
 * The first call made through `NestFactory`, as `NestFactory.create`. Read by
 * syntax alone, unlike main.ts's analysis, because the file may be compiled
 * or bundled — `core_1.NestFactory.create`,
 * `_nestjs_core__WEBPACK_IMPORTED_MODULE_0__.NestFactory.create` — so any base
 * may be `@nestjs/core`, and a name bound to `NestFactory` anywhere counts
 * everywhere. A false refusal costs a `--entry`; a missed bootstrap starts
 * the application.
 */
export function findNestFactoryCall(sourceFile: ts.SourceFile): string | undefined {
  const [first] = factoryCalls(sourceFile, leniently(factoryAliases(sourceFile)));
  return first && `${NEST_FACTORY}${first.method === undefined ? "[…]" : `.${first.method}`}`;
}

function leniently(aliases: ReadonlyMap<string, FactoryReference>): FactoryReading {
  return {
    lenient: true,
    base: (base) =>
      ts.isIdentifier(base)
        ? (aliases.get(base.text) ?? (base.text === NEST_FACTORY ? FACTORY : MODULE))
        : MODULE,
  };
}

/**
 * The names bound to `NestFactory` or to one of its methods: imported under
 * another name, declared or assigned with it, destructured from it. Scopes
 * are not told apart, and a name bound both ways stays a method, which every
 * call through it is — either way the guard only refuses more.
 */
function factoryAliases(sourceFile: ts.SourceFile): ReadonlyMap<string, FactoryReference> {
  const aliases = new Map<string, FactoryReference>();
  const reading = leniently(aliases);
  const bind = (name: string, reference: FactoryReference | undefined) => {
    if (
      reference?.kind === "method" ||
      (reference?.kind === "factory" && aliases.get(name)?.kind !== "method")
    ) {
      aliases.set(name, reference);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === NEST_FACTORY) {
      bind(node.name.text, FACTORY);
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      const reference = readFactoryReference(node.initializer, reading);
      if (ts.isIdentifier(node.name)) {
        bind(node.name.text, reference);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isIdentifier(element.name)) {
            const property = element.propertyName
              ? propertyNameText(element.propertyName)
              : element.name.text;
            bind(element.name.text, memberOf(reference, property, true));
          }
        }
      }
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const target = unwrap(node.left);
      if (ts.isIdentifier(target)) {
        bind(target.text, readFactoryReference(node.right, reading));
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return aliases;
}
