/**
 * Builds the payload the documentation site hands to nodepod, so the demo the
 * site shows is this application actually running rather than a captured
 * graph file.
 *
 * The bundle is produced from the `nest build` output on purpose. Decorator
 * metadata is what Nest resolves constructor dependencies from, and TypeScript
 * is the only compiler in this repository that emits it; the bundler only
 * stitches the emitted JavaScript together.
 *
 * The application itself knows nothing about any of this. It is an ordinary
 * NestJS project that would run the same way if it were copied somewhere else,
 * and what the browser runtime needs differently is prepended here instead.
 *
 * Run it through `pnpm --filter nest-graph-inspector-demo run build:nodepod`,
 * which compiles this file and the application before executing it.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Nest requires these lazily, and only for features the demo does not use.
 * Leaving them unresolved keeps the failure exactly where it is on a real
 * machine that never installed them.
 */
const OPTIONAL_NEST_PEERS = [
  '@nestjs/microservices',
  '@nestjs/microservices/microservices-module',
  '@nestjs/websockets/socket-module',
  'class-transformer',
  'class-validator',
];

/**
 * Compiler options that only describe how this repository builds, and would
 * mean nothing to the copy of the sources that travels into the browser.
 */
const IRRELEVANT_COMPILER_OPTIONS = [
  'baseUrl',
  'declaration',
  'declarationMap',
  'incremental',
  'outDir',
  'sourceMap',
  'tsBuildInfoFile',
  'types',
];

const WORKDIR = '/app';

/**
 * Prepended to the bundle, so the application can stay an ordinary NestJS
 * project while the browser runtime gets what it needs.
 *
 * Two differences from Node, neither of which the application should have to
 * know about:
 *
 * - The runtime has two `Buffer` implementations that do not recognise each
 *   other: `require('buffer').Buffer` is not the global one, and each one's
 *   `isBuffer` rejects what the other made. Express builds a response body with
 *   one and hands it to `etag`, which checks with the other — so every response
 *   from the application's own routes is a 500. Making recognition symmetric is
 *   enough; nothing here changes what is created.
 * - A process ends as soon as the event loop looks empty, and neither a
 *   virtual HTTP server nor an in-flight cross-origin fetch holds it open. The
 *   inspector awaits one during startup to report the latest published
 *   version, so without a timer the application exits underneath its own
 *   bootstrap. A server that runs until it is stopped is what happens on a real
 *   machine anyway.
 */
const RUNTIME_ACCOMMODATIONS = `
(() => {
  const moduleBuffer = require('buffer').Buffer;
  const globalBuffer = globalThis.Buffer;

  if (moduleBuffer && globalBuffer && moduleBuffer !== globalBuffer) {
    const recognisedByModule = moduleBuffer.isBuffer.bind(moduleBuffer);
    const recognisedByGlobal = globalBuffer.isBuffer.bind(globalBuffer);
    const isBuffer = (value) =>
      recognisedByGlobal(value) || recognisedByModule(value);

    moduleBuffer.isBuffer = isBuffer;
    globalBuffer.isBuffer = isBuffer;
  }

  setInterval(() => undefined, 60000);
})();
`;

type JsonObject = Record<string, unknown>;

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

function toPosixPath(path: string): string {
  return path.split(sep).join('/');
}

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        return listSourceFiles(path);
      }

      return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
        ? [path]
        : [];
    }),
  );

  return files.flat().sort();
}

async function readJsonFile(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(path, 'utf8')) as JsonObject;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * The demo's own tsconfig extends a file that lives outside the demo, and the
 * browser copy has no repository around it. Flattening the two into one
 * self-contained file keeps `ts-morph` — the library's source metadata reader,
 * which is what produces JSDoc and direct-run parameter types — reading the
 * same compiler options it reads locally.
 */
async function buildPodTsConfig(
  repoDir: string,
  demoDir: string,
): Promise<string> {
  const baseConfig = await readJsonFile(join(repoDir, 'tsconfig.base.json'));
  const demoConfig = await readJsonFile(join(demoDir, 'tsconfig.json'));
  const compilerOptions: JsonObject = {
    ...(baseConfig.compilerOptions as JsonObject),
    ...(demoConfig.compilerOptions as JsonObject),
  };

  for (const option of IRRELEVANT_COMPILER_OPTIONS) {
    delete compilerOptions[option];
  }

  return `${JSON.stringify({ compilerOptions, include: ['src'] }, null, 2)}\n`;
}

async function main(): Promise<void> {
  const repoDir = findRepoDir(process.cwd());
  const demoDir = join(repoDir, 'demo');
  const entryPath = join(demoDir, 'dist/src/main.js');
  const outputDir = join(repoDir, 'site/public/nodepod-demo');

  if (!existsSync(entryPath)) {
    throw new Error(
      `Compiled demo entry not found at ${entryPath}. Run "nest build" in demo/ first.`,
    );
  }

  const bundleResult = await build({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: OPTIONAL_NEST_PEERS,
    banner: { js: RUNTIME_ACCOMMODATIONS },
    write: false,
    logLevel: 'warning',
  });

  const bundle = bundleResult.outputFiles[0]?.text;

  if (!bundle) {
    throw new Error('esbuild produced no output for the demo entry.');
  }

  const demoPackage = await readJsonFile(join(demoDir, 'package.json'));
  const libraryPackage = await readJsonFile(join(repoDir, 'lib/package.json'));
  const sourceDir = join(demoDir, 'src');
  const sources: Record<string, string> = {
    'package.json': `${JSON.stringify(
      {
        name: demoPackage.name,
        version: demoPackage.version,
        private: true,
        main: 'main.js',
      },
      null,
      2,
    )}\n`,
    'tsconfig.json': await buildPodTsConfig(repoDir, demoDir),
  };

  for (const path of await listSourceFiles(sourceDir)) {
    const key = `src/${toPosixPath(relative(sourceDir, path))}`;
    sources[key] = await readFile(path, 'utf8');
  }

  const sourcesJson = `${JSON.stringify(sources, null, 2)}\n`;
  const revision = sha256(`${bundle}${sourcesJson}`).slice(0, 12);
  const manifest = {
    payloadVersion: 1,
    revision,
    builtAt: new Date().toISOString(),
    demoVersion: demoPackage.version,
    libraryVersion: libraryPackage.version,
    workdir: WORKDIR,
    entry: 'main.js',
    sources: 'sources.json',
    env: {
      NODE_ENV: 'development',
    },
    bundleBytes: Buffer.byteLength(bundle),
    sourceFileCount: Object.keys(sources).length,
  };

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'main.js'), bundle, 'utf8');
  await writeFile(join(outputDir, 'sources.json'), sourcesJson, 'utf8');
  await writeFile(
    join(outputDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  const megabytes = (manifest.bundleBytes / 1024 / 1024).toFixed(1);
  console.log(
    `Wrote nodepod demo payload to ${outputDir} (${megabytes} MB bundle, ${manifest.sourceFileCount} source files, revision ${revision})`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
