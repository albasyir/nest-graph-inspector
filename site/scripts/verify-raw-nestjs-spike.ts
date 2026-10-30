/**
 * Boots a hand-written, multi-file NestJS application under nodepod and checks
 * that it answers an HTTP request, within a startup budget.
 *
 * Where `verify-nodepod-payload.ts` boots the demo as one prebuilt bundle, this
 * restores `@nestjs/*` into the pod's own `node_modules` from the vendor
 * snapshot and starts four separate CommonJS files, so module resolution and
 * Express's response path are both exercised by the runtime itself. The files
 * and the restore helper come from `app/utils/raw-nestjs-spike.ts`, the same
 * source the `/raw-spike` page uses.
 *
 * Needs the snapshot `build:raw-spike-snapshot` writes; no network access.
 * `RAW_SPIKE_STARTUP_BUDGET_MS` overrides the budget on a slow machine.
 */
import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { Nodepod } from '@scelar/nodepod/headless'
import {
  RAW_SPIKE_ENTRY,
  RAW_SPIKE_FILES,
  RAW_SPIKE_PORT,
  RAW_SPIKE_READY_LINE,
  RAW_SPIKE_REQUEST_PATH,
  RAW_SPIKE_SNAPSHOT_PATH,
  RAW_SPIKE_WORKDIR,
  isRawSpikeHelloBody,
  loadAndRestoreSnapshot
} from '../app/utils/raw-nestjs-spike.ts'
import type { RawSpikeSnapshotStats } from '../app/utils/raw-nestjs-spike.ts'

const STARTUP_TIMEOUT_MS = 120_000
const STARTUP_BUDGET_MS = Number(process.env.RAW_SPIKE_STARTUP_BUDGET_MS ?? 3_500)
const SNAPSHOT_FILE = fileURLToPath(new URL(`../public${RAW_SPIKE_SNAPSHOT_PATH}`, import.meta.url))

// A malformed override reads as NaN, and no comparison with NaN is true, so the
// budget check would pass however long the startup took.
if (!Number.isFinite(STARTUP_BUDGET_MS) || STARTUP_BUDGET_MS <= 0) {
  console.error(
    `RAW_SPIKE_STARTUP_BUDGET_MS must be a positive number of milliseconds, got "${process.env.RAW_SPIKE_STARTUP_BUDGET_MS}".`
  )
  process.exit(1)
}

const ms = (value: number) => `${value.toFixed(0)} ms`
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`

let snapshotBytes: Buffer

try {
  snapshotBytes = await readFile(SNAPSHOT_FILE)
} catch {
  console.error(
    `No vendor snapshot at ${SNAPSHOT_FILE}.\n`
    + 'Build it first: pnpm --filter nest-graph-inspector-site run build:raw-spike-snapshot'
  )
  process.exit(1)
}

const bootStartedAt = performance.now()
const pod = await Nodepod.boot({ workdir: RAW_SPIKE_WORKDIR })
const bootMs = performance.now() - bootStartedAt

let log = ''
let exitCode: number | undefined

/**
 * Reports a failed check with the application's output, tears the pod down and
 * exits non-zero, so no failure leaves a booted pod behind.
 */
function fail(message: string): never {
  console.error(`${message}\n\n--- application output ---\n${log}`)
  pod.teardown()
  process.exit(1)
}

// Restore replaces the whole volume, so it runs before the project is written.
let snapshot: RawSpikeSnapshotStats

try {
  snapshot = await loadAndRestoreSnapshot(pod, snapshotBytes)
} catch (error) {
  fail(`Restoring the vendor snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
}

const ingestMs = snapshot.fetchMs + snapshot.decodeMs + snapshot.restoreMs

const writeStartedAt = performance.now()

for (const [path, content] of Object.entries(RAW_SPIKE_FILES)) {
  await pod.fs.writeFile(path, content)
}

const writeMs = performance.now() - writeStartedAt

const spawnStartedAt = performance.now()
const app = await pod.spawn('node', [RAW_SPIKE_ENTRY], { cwd: RAW_SPIKE_WORKDIR })

app.on('output', (chunk: string) => {
  log += chunk
})
app.on('error', (chunk: string) => {
  log += chunk
})
app.on('exit', (code: number) => {
  exitCode = code
})

while (!log.includes(RAW_SPIKE_READY_LINE)) {
  if (exitCode !== undefined) {
    fail(`The application exited with code ${exitCode} before printing "${RAW_SPIKE_READY_LINE}".`)
  }

  if (performance.now() - spawnStartedAt > STARTUP_TIMEOUT_MS) {
    fail(`The application did not print "${RAW_SPIKE_READY_LINE}" within ${ms(STARTUP_TIMEOUT_MS)}.`)
  }

  await new Promise(resolve => setTimeout(resolve, 10))
}

const startupMs = performance.now() - spawnStartedAt
const totalMs = bootMs + ingestMs + writeMs + startupMs

const requestStartedAt = performance.now()
const response = await pod.request(RAW_SPIKE_PORT, { path: RAW_SPIKE_REQUEST_PATH })
const requestMs = performance.now() - requestStartedAt
const body = Buffer.from(response.body ?? []).toString()

if (response.statusCode !== 200) {
  fail(`GET ${RAW_SPIKE_REQUEST_PATH} answered ${response.statusCode}: ${body.slice(0, 300)}`)
}

let parsed: unknown

try {
  parsed = JSON.parse(body)
} catch {
  fail(`GET ${RAW_SPIKE_REQUEST_PATH} answered a body that is not JSON: ${body.slice(0, 300)}`)
}

assert.ok(
  isRawSpikeHelloBody(parsed),
  `GET ${RAW_SPIKE_REQUEST_PATH} answered ${body}, expected { message, success: true }`
)

const memory = pod.memoryStats()
const installed = pod.packages.listInstalled()

console.log(`raw NestJS spike ok: GET ${RAW_SPIKE_REQUEST_PATH} → ${response.statusCode} ${body}`)
console.table({
  'pod boot': ms(bootMs),
  'snapshot ingestion': `${ms(ingestMs)} (read ${ms(snapshot.fetchMs)}, decode ${ms(snapshot.decodeMs)}, restore ${ms(snapshot.restoreMs)})`,
  'VFS write': ms(writeMs),
  'startup (spawn → ready)': ms(startupMs),
  'request latency': ms(requestMs),
  'total startup': `${ms(totalMs)} (budget ${ms(STARTUP_BUDGET_MS)})`
})
console.table({
  'snapshot (gzip → JSON)': `${mb(snapshot.compressedBytes)} → ${mb(snapshot.uncompressedBytes)}`,
  'snapshot entries': `${snapshot.entryCount.toLocaleString()} (${snapshot.fileCount.toLocaleString()} files)`,
  'installed packages': Object.keys(installed).length,
  'VFS files': memory.vfs.fileCount,
  'VFS size': mb(memory.vfs.totalBytes),
  'module cache entries': memory.engine.moduleCacheSize,
  'processes': memory.runtime.processes,
  'heap used': memory.heap ? `${memory.heap.usedMB.toFixed(1)} MB` : 'n/a',
  'host RSS': mb(process.memoryUsage().rss)
})

if (totalMs > STARTUP_BUDGET_MS) {
  fail(`Total startup took ${ms(totalMs)}, over the ${ms(STARTUP_BUDGET_MS)} budget.`)
}

pod.teardown()
process.exit(0)
