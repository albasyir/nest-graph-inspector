/**
 * A failure the CLI explains in its own words, rather than as a stack trace:
 * a missing entry file, an export that is not a module, an application that
 * would not bootstrap. When it carries a `cause`, the cause's stack is printed
 * after the message, for failures inside the user's own code.
 */
export class CliError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliError";
  }
}

export function describeError(error: unknown): string {
  return isErrorLike(error) ? error.message : String(error);
}

export function stackOf(error: unknown): string {
  return isErrorLike(error) ? (error.stack ?? error.message) : String(error);
}

/**
 * Recognised by shape rather than `instanceof Error`, which fails for an
 * error from another realm — one Node's own internals threw into a VM
 * context, for instance.
 */
export function isErrorLike(
  error: unknown,
): error is { message: string; stack?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { message?: unknown }).message === "string" &&
    ["string", "undefined"].includes(typeof (error as { stack?: unknown }).stack)
  );
}
