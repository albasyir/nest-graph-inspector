import { inspect } from "node:util";
import type { LoggerService } from "@nestjs/common";
import { isErrorLike, stackOf } from "./cli-error";

/**
 * Nest logs this banner whenever an application starts in preview mode. The
 * export says it runs in preview mode in its own summary, in one line.
 */
const PREVIEW_MODE_BANNER = new Set([
  "------------------------------------------------",
  "Application is running in the PREVIEW mode!",
  "Providers/controllers will not be instantiated.",
]);

type Level = "WARN" | "ERROR" | "FATAL";

/**
 * The logger the application is booted with during an export: warnings and
 * errors go to stderr, everything else is dropped. Standard output is kept
 * for the graph itself, which `--out -` writes there.
 *
 * Nest passes the context last (`Logger#warn(message, context)`,
 * `Logger#error(message, stack, context)`), so a trailing one-line string is
 * read as the context, and anything else is printed after the message — a
 * stack passed without a context included.
 */
export function createStderrLogger(write: (text: string) => void): LoggerService {
  const print = (level: Level, message: unknown, params: unknown[]): void => {
    const last = params.at(-1);
    const context =
      typeof last === "string" && !last.includes("\n") ? last : undefined;
    const details = (context === undefined ? params : params.slice(0, -1))
      .filter((param) => param !== undefined)
      .map(format);
    const text = format(message);

    if (context === "NestApplicationContext" && PREVIEW_MODE_BANNER.has(text)) {
      return;
    }

    write(
      [`[Nest] ${level} ${context ? `[${context}] ` : ""}${text}`, ...details]
        .join("\n")
        .concat("\n"),
    );
  };

  return {
    log: () => undefined,
    debug: () => undefined,
    verbose: () => undefined,
    warn: (message: unknown, ...params: unknown[]) =>
      print("WARN", message, params),
    error: (message: unknown, ...params: unknown[]) =>
      print("ERROR", message, params),
    fatal: (message: unknown, ...params: unknown[]) =>
      print("FATAL", message, params),
  };
}

function format(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (isErrorLike(value)) {
    return stackOf(value);
  }

  return inspect(value);
}
