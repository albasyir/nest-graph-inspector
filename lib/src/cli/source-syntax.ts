import { extname } from "node:path";
import { ts } from "ts-morph";

/**
 * Source read as syntax, never run. Calls made through `NestFactory` are found
 * by one walk, read two ways: leniently by the load guard, which only refuses
 * (`load-guard.ts`), and strictly, scope by scope, by main.ts's analysis,
 * which decides the root module (`root-module-detection.ts`).
 */

export const NEST_FACTORY = "NestFactory";
export const NEST_CORE = "@nestjs/core";

export function parseSourceFile(path: string, text: string): ts.SourceFile {
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKindOf(path));
}

export function scriptKindOf(path: string): ts.ScriptKind {
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

/** What an expression is of `@nestjs/core`: the module, its `NestFactory`, or a method of that. */
export type FactoryReference =
  | { kind: "module" }
  | { kind: "factory" }
  /** Undefined for a computed `NestFactory[name]`. */
  | { kind: "method"; name: string | undefined };

/**
 * How a member chain is read: what its base refers to, and whether to read it
 * leniently — any member of a module may hold `NestFactory`, and a method
 * stays one through `.call` or `.bind` — which only ever finds more calls.
 */
export type FactoryReading = {
  base: (expression: ts.Expression) => FactoryReference | undefined;
  lenient: boolean;
};

export function readFactoryReference(
  expression: ts.Expression,
  reading: FactoryReading,
): FactoryReference | undefined {
  const { base, names } = memberChain(expression);
  return names.reduce<FactoryReference | undefined>(
    (reference, name) => memberOf(reference, name, reading.lenient),
    reading.base(base),
  );
}

export function memberOf(
  reference: FactoryReference | undefined,
  name: string | undefined,
  lenient: boolean,
): FactoryReference | undefined {
  switch (reference?.kind) {
    case "module":
      return name === NEST_FACTORY ? { kind: "factory" } : lenient ? reference : undefined;
    case "factory":
      return { kind: "method", name };
    case "method":
      return lenient ? reference : undefined;
    default:
      return undefined;
  }
}

/** Every call whose callee reads, under `reading`, as a method of `NestFactory`, in source order. */
export function factoryCalls(
  sourceFile: ts.SourceFile,
  reading: FactoryReading,
): { call: ts.CallExpression; method: string | undefined }[] {
  const calls: { call: ts.CallExpression; method: string | undefined }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = readFactoryReference(node.expression, reading);
      if (callee?.kind === "method") {
        calls.push({ call: node, method: callee.name });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return calls;
}

/** `a.b["c"].d` as its base `a` and the names `b`, `c`, `d`; a computed name (`a[key]`) is undefined. */
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
export function unwrap(expression: ts.Expression): ts.Expression {
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

export function propertyNameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}
