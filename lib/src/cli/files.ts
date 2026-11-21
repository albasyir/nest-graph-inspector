import { statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/** A path relative to `cwd` when it lies inside it, else absolute. */
export function displayPath(path: string, cwd: string): string {
  const relativePath = relative(cwd, path);
  const outside =
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath);

  return relativePath && !outside ? relativePath : path;
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
