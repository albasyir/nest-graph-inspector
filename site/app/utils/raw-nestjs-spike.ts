/**
 * A plain, hand-written NestJS application for the raw-NestJS spike: four
 * CommonJS files and the packages they need, restored into the pod from a
 * prebuilt `node_modules` snapshot rather than bundled ahead of time.
 *
 * The demo payload proves a prebuilt bundle starts under nodepod; this proves
 * an ordinary multi-file project does, resolving `@nestjs/*` out of a real
 * `node_modules`. Both `scripts/verify-raw-nestjs-spike.ts` and the
 * `/raw-spike` page boot exactly these files, so the page shows what the check
 * verifies.
 *
 * The sources are JavaScript with no decorator syntax: `Reflect.decorate` and
 * an explicit `design:paramtypes` entry stand in for what `tsc` would emit
 * with `emitDecoratorMetadata`.
 */
import type { Snapshot } from '@scelar/nodepod'

export const RAW_SPIKE_WORKDIR = '/app'
export const RAW_SPIKE_ENTRY = 'main.js'
export const RAW_SPIKE_PORT = 3333
export const RAW_SPIKE_REQUEST_PATH = '/api/hello'
export const RAW_SPIKE_READY_LINE = `NESTJS RAW MULTI-FILE READY ON ${RAW_SPIKE_PORT}`
export const RAW_SPIKE_MESSAGE = 'Hello from raw NestJS running inside nodepod'

/** Exact versions, so a run measures the runtime rather than a moving target. */
export const RAW_SPIKE_PACKAGES: ReadonlyArray<readonly [name: string, version: string]> = [
  ['reflect-metadata', '0.2.2'],
  ['rxjs', '7.8.1'],
  ['@nestjs/common', '11.2.1'],
  ['@nestjs/core', '11.2.1'],
  ['@nestjs/platform-express', '11.2.1']
]

const APP_SERVICE = `const { Injectable } = require('@nestjs/common');

class AppService {
  getHello() {
    return { message: ${JSON.stringify(RAW_SPIKE_MESSAGE)}, success: true };
  }
}

Reflect.decorate([Injectable()], AppService);

module.exports = { AppService };
`

const APP_CONTROLLER = `const { Controller, Get } = require('@nestjs/common');
const { AppService } = require('./app.service');

class AppController {
  constructor(appService) {
    this.appService = appService;
  }

  getHello() {
    return this.appService.getHello();
  }
}

Reflect.decorate(
  [Get('hello')],
  AppController.prototype,
  'getHello',
  Object.getOwnPropertyDescriptor(AppController.prototype, 'getHello')
);
Reflect.decorate(
  [Controller('api'), Reflect.metadata('design:paramtypes', [AppService])],
  AppController
);

module.exports = { AppController };
`

const APP_MODULE = `const { Module } = require('@nestjs/common');
const { AppController } = require('./app.controller');
const { AppService } = require('./app.service');

class AppModule {}

Reflect.decorate(
  [Module({ controllers: [AppController], providers: [AppService] })],
  AppModule
);

module.exports = { AppModule };
`

// The two accommodations mirror demo/scripts/build-nodepod-payload.ts: the
// runtime's two Buffer implementations must recognise each other or Express's
// ETag hashing turns every response into a 500, and a timer keeps the event
// loop alive because a virtual HTTP server alone does not.
const MAIN = `require('reflect-metadata');

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

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('./app.module');

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  await app.listen(${RAW_SPIKE_PORT});
  console.log(${JSON.stringify(RAW_SPIKE_READY_LINE)});
}

bootstrap().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`

/** The project files, keyed by absolute path inside the pod. */
export const RAW_SPIKE_FILES: Readonly<Record<string, string>> = {
  [`${RAW_SPIKE_WORKDIR}/package.json`]: `${JSON.stringify(
    {
      name: 'raw-nestjs-spike',
      private: true,
      main: RAW_SPIKE_ENTRY,
      dependencies: Object.fromEntries(RAW_SPIKE_PACKAGES)
    },
    null,
    2
  )}\n`,
  [`${RAW_SPIKE_WORKDIR}/app.service.js`]: APP_SERVICE,
  [`${RAW_SPIKE_WORKDIR}/app.controller.js`]: APP_CONTROLLER,
  [`${RAW_SPIKE_WORKDIR}/app.module.js`]: APP_MODULE,
  [`${RAW_SPIKE_WORKDIR}/${RAW_SPIKE_ENTRY}`]: MAIN
}

export type RawSpikeHelloBody = { message: string, success: true }

/**
 * Checks a response body is the one `AppService.getHello` returns, so the
 * script and the page agree on what "it answered" means.
 */
export function isRawSpikeHelloBody(value: unknown): value is RawSpikeHelloBody {
  if (!value || typeof value !== 'object') {
    return false
  }

  const body = value as Record<string, unknown>

  return typeof body.message === 'string' && body.message.length > 0 && body.success === true
}

/**
 * Where `scripts/build-raw-spike-snapshot.ts` writes the vendor snapshot,
 * relative to the site's public directory — and so to the site's base URL.
 */
export const RAW_SPIKE_SNAPSHOT_PATH = '/raw-spike/raw-nestjs-vendor-snapshot.json.gz'

/**
 * The file behind {@link RAW_SPIKE_SNAPSHOT_PATH}: a nodepod volume snapshot
 * with `RAW_SPIKE_PACKAGES` installed, plus the versions it was built from, so
 * a snapshot left behind by a version bump is refused instead of run.
 */
export type RawSpikeVendorSnapshot = Snapshot & {
  packages: Record<string, string>
}

/** What a restore needs from a pod; both the browser and headless builds fit. */
export type RawSpikeSnapshotTarget = {
  restore: (snapshot: Snapshot, opts?: { shallow?: boolean, autoInstall?: boolean }) => Promise<void>
}

export type RawSpikeSnapshotPhase = 'fetch' | 'decode' | 'restore'

export type RawSpikeSnapshotStats = {
  compressedBytes: number
  uncompressedBytes: number
  entryCount: number
  fileCount: number
  fetchMs: number
  decodeMs: number
  restoreMs: number
}

const GZIP_MAGIC = [0x1F, 0x8B] as const

function isGzip(bytes: Uint8Array) {
  return bytes[0] === GZIP_MAGIC[0] && bytes[1] === GZIP_MAGIC[1]
}

/**
 * Checks a decoded snapshot is one this spike can run: the right shape, and
 * built from exactly the package versions the application files declare.
 */
export function assertRawSpikeVendorSnapshot(value: unknown): asserts value is RawSpikeVendorSnapshot {
  if (!value || typeof value !== 'object') {
    throw new Error('The vendor snapshot is not a JSON object.')
  }

  const snapshot = value as Partial<RawSpikeVendorSnapshot>

  if (!Array.isArray(snapshot.entries) || !snapshot.packages || typeof snapshot.packages !== 'object') {
    throw new Error('The vendor snapshot has no `entries` or `packages`.')
  }

  const expected = Object.fromEntries(RAW_SPIKE_PACKAGES)
  const stale = Object.entries(expected).filter(([name, version]) => snapshot.packages?.[name] !== version)

  if (stale.length || Object.keys(snapshot.packages).length !== RAW_SPIKE_PACKAGES.length) {
    throw new Error(
      `The vendor snapshot was built from different package versions than RAW_SPIKE_PACKAGES `
      + `(${stale.map(([name, version]) => `${name}@${version}`).join(', ') || 'extra packages'}). `
      + 'Rebuild it with `pnpm --filter nest-graph-inspector-site run build:raw-spike-snapshot`.'
    )
  }
}

/**
 * Decodes the bytes of a vendor snapshot file. Uses `DecompressionStream`,
 * which browsers and Node 18+ both provide, so one implementation serves the
 * page and the verification script. Bytes that are not gzip are read as
 * plain JSON: a server that answers with `Content-Encoding: gzip` has already
 * inflated them.
 */
export async function decodeRawSpikeSnapshot(
  bytes: ArrayBuffer | Uint8Array
): Promise<{ snapshot: RawSpikeVendorSnapshot, uncompressedBytes: number }> {
  // A copy, so the view is backed by a plain ArrayBuffer whatever came in.
  const view = new Uint8Array(bytes)
  const text = isGzip(view)
    ? await new Response(new Blob([view]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    : new TextDecoder().decode(view)
  const parsed: unknown = JSON.parse(text)

  assertRawSpikeVendorSnapshot(parsed)

  return { snapshot: parsed, uncompressedBytes: text.length }
}

/**
 * Replaces the pod's volume with the vendor snapshot, so `node_modules` is
 * there without a registry round trip.
 *
 * `source` is either a URL — fetched, which is what the browser does — or the
 * file's bytes, which is what a Node script that read it from disk passes.
 * `restore` swaps the whole volume, so call this before writing anything else
 * into the pod.
 */
export async function loadAndRestoreSnapshot(
  pod: RawSpikeSnapshotTarget,
  source: string | URL | ArrayBuffer | Uint8Array,
  onPhase?: (phase: RawSpikeSnapshotPhase) => void
): Promise<RawSpikeSnapshotStats> {
  onPhase?.('fetch')
  const fetchStartedAt = performance.now()
  let bytes: ArrayBuffer | Uint8Array

  if (typeof source === 'string' || source instanceof URL) {
    const response = await fetch(source)

    if (!response.ok) {
      throw new Error(
        `Fetching the vendor snapshot answered ${response.status}. `
        + 'Build it with `pnpm --filter nest-graph-inspector-site run build:raw-spike-snapshot`.'
      )
    }

    bytes = await response.arrayBuffer()
  } else {
    bytes = source
  }

  const fetchMs = performance.now() - fetchStartedAt

  onPhase?.('decode')
  const decodeStartedAt = performance.now()
  const { snapshot, uncompressedBytes } = await decodeRawSpikeSnapshot(bytes)
  const decodeMs = performance.now() - decodeStartedAt

  onPhase?.('restore')
  const restoreStartedAt = performance.now()
  await pod.restore({ entries: snapshot.entries }, { autoInstall: false })
  const restoreMs = performance.now() - restoreStartedAt

  return {
    compressedBytes: bytes.byteLength,
    uncompressedBytes,
    entryCount: snapshot.entries.length,
    fileCount: snapshot.entries.filter(entry => entry.kind === 'file').length,
    fetchMs,
    decodeMs,
    restoreMs
  }
}
