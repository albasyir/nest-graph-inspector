import { statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/**
 * `path` relative to `dir` when it lies inside it; undefined when it is `dir`
 * itself, or lies outside it.
 */
export function pathInside(dir: string, path: string): string | undefined {
  const relativePath = relative(dir, path);
  const outside =
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);

  return outside ? undefined : relativePath;
}

/** A path relative to `cwd` when it lies inside it, else absolute. */
export function displayPath(path: string, cwd: string): string {
  return pathInside(cwd, path) ?? path;
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
