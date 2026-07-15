import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

function findRepoDir(startDir: string): string {
  let currentDir = resolve(startDir);

  while (true) {
    if (
      existsSync(resolve(currentDir, 'lib')) &&
      existsSync(resolve(currentDir, 'site/public'))
    ) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);

    if (parentDir === currentDir) {
      throw new Error(
        `Unable to find repository root from current directory: ${startDir}`,
      );
    }

    currentDir = parentDir;
  }
}

const repoDir = findRepoDir(process.cwd());
const cwdGraphDir = resolve(process.cwd(), 'tmp/graph');
const graphDir = existsSync(cwdGraphDir)
  ? cwdGraphDir
  : resolve(repoDir, 'demo/tmp/graph');
const mockGraphDir = resolve(repoDir, 'site/public/mock-graph');

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function main(): void {
  if (!existsSync(graphDir)) {
    throw new Error(`Graph output directory not found: ${graphDir}`);
  }

  mkdirSync(mockGraphDir, { recursive: true });

  const graphFiles = listFiles(graphDir).sort();

  if (graphFiles.length === 0) {
    throw new Error(`No graph output files found in: ${graphDir}`);
  }

  for (const sourcePath of graphFiles) {
    const destinationPath = resolve(mockGraphDir, relative(graphDir, sourcePath));
    mkdirSync(dirname(destinationPath), { recursive: true });
    copyFileSync(sourcePath, destinationPath);
    console.log(`Copied ${sourcePath} to ${destinationPath}`);
  }
}

main();
