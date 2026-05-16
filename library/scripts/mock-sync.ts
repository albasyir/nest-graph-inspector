import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

function findRepoDir(startDir: string): string {
  let currentDir = resolve(startDir);

  while (true) {
    if (
      existsSync(resolve(currentDir, 'library/libs')) &&
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
  : resolve(repoDir, 'library/tmp/graph');
const mockGraphDir = resolve(repoDir, 'site/public/mock-graph');

function main(): void {
  if (!existsSync(graphDir)) {
    throw new Error(`Graph output directory not found: ${graphDir}`);
  }

  mkdirSync(mockGraphDir, { recursive: true });

  const graphFiles = readdirSync(graphDir)
    .map((fileName) => resolve(graphDir, fileName))
    .filter((filePath) => statSync(filePath).isFile())
    .sort();

  if (graphFiles.length === 0) {
    throw new Error(`No graph output files found in: ${graphDir}`);
  }

  for (const sourcePath of graphFiles) {
    const destinationPath = resolve(mockGraphDir, basename(sourcePath));
    copyFileSync(sourcePath, destinationPath);
    console.log(`Copied ${sourcePath} to ${destinationPath}`);
  }
}

main();
