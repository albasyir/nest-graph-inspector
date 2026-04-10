import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const rootDir = process.cwd();
const distDir = resolve(rootDir, 'dist/libs/nest-graph-inspector');

function getVersionArg(): string {
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--version') {
      const value = args[i + 1];

      if (!value) {
        throw new Error(
          'Missing value for --version\nUsage: ./scripts/release.ts --version 3.0.0',
        );
      }

      return value;
    }

    throw new Error(
      `Unknown argument: ${arg}\nUsage: ./scripts/release.ts --version 3.0.0`,
    );
  }

  throw new Error(
    'Missing required argument: --version\nUsage: ./scripts/release.ts --version 3.0.0',
  );
}

function main(): void {
  const version = getVersionArg();
  const readmePath = resolve(rootDir, 'README.md');
  const sourcePackageJsonPath = resolve(
    rootDir,
    'libs/nest-graph-inspector/package.json',
  );
  const distPackageJsonPath = resolve(distDir, 'package.json');
  const distReadmePath = resolve(distDir, 'README.md');

  console.log('Building package...');
  execSync('npm run build', {
    cwd: rootDir,
    stdio: 'inherit',
  });

  if (!existsSync(readmePath)) {
    throw new Error(`README.md not found in root project: ${readmePath}`);
  }

  if (!existsSync(sourcePackageJsonPath)) {
    throw new Error(
      `package.json not found in library: ${sourcePackageJsonPath}`,
    );
  }

  if (!existsSync(distDir)) {
    throw new Error(`Dist directory not found: ${distDir}`);
  }

  copyFileSync(readmePath, distReadmePath);
  copyFileSync(sourcePackageJsonPath, distPackageJsonPath);

  const pkg = JSON.parse(readFileSync(distPackageJsonPath, 'utf8')) as Record<
    string,
    unknown
  >;
  pkg.version = version;
  writeFileSync(distPackageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);

  console.log(`Copied README.md to ${distReadmePath}`);
  console.log(`Copied package.json to ${distPackageJsonPath}`);
  console.log(`Updated package.json version to ${version}`);

  console.log(`Publishing package from ${distDir}...`);
  execSync('npm publish', {
    cwd: distDir,
    stdio: 'inherit',
  });
  console.log(`Published ${pkg.name}@${version}`);
}

main();
