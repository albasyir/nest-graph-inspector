import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ts } from "ts-morph";

/** `path` relative to `dir`; undefined when it is `dir` itself or lies outside it. */
export function pathInside(dir: string, path: string): string | undefined {
  const relativePath = relative(dir, path);
  const outside =
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);

  return outside ? undefined : relativePath;
}

export function displayPath(path: string, cwd: string): string {
  return pathInside(cwd, path) ?? path;
}

/** `a and b`, `a, b and c`. */
export function joinedPaths(paths: readonly string[], cwd: string): string {
  const shown = paths.map((path) => displayPath(path, cwd));
  const last = shown.pop();
  return shown.length ? `${shown.join(", ")} and ${last ?? ""}` : (last ?? "");
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether two paths name one file, as the file system resolves them —
 * symlinks followed, case folded where it ignores case — or, where nothing is
 * there, by their resolved spelling.
 */
export function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function pathKey(path: string): string {
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    real = resolve(path);
  }

  return ts.sys.useCaseSensitiveFileNames ? real : real.toLowerCase();
}
