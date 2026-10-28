/**
 * Boots a hand-written, multi-file NestJS application under nodepod and checks
 * that it answers an HTTP request.
 *
 * Where `verify-nodepod-payload.ts` boots the demo as one prebuilt bundle, this
 * installs `@nestjs/*` from the registry into the pod's own `node_modules` and
 * starts four separate CommonJS files, so module resolution, the package
 * installer, and Express's response path are all exercised by the runtime
 * itself. The files come from `app/utils/raw-nestjs-spike.ts`, the same source
 * the `/raw-spike` page boots.
 *
 * Needs network access to the npm registry.
 */
import { strict as assert } from 'node:assert'
import { Nodepod } from '@scelar/nodepod/headless'
import {
  RAW_SPIKE_ENTRY,
  RAW_SPIKE_FILES,
  RAW_SPIKE_PACKAGES,
  RAW_SPIKE_PORT,
  RAW_SPIKE_READY_LINE,
  RAW_SPIKE_REQUEST_PATH,
  RAW_SPIKE_WORKDIR,
  isRawSpikeHelloBody
} from '../app/utils/raw-nestjs-spike.ts'

const STARTUP_TIMEOUT_MS = 120_000

const ms = (value: number) => `${value.toFixed(0)} ms`

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

const writeStartedAt = performance.now()

for (const [path, content] of Object.entries(RAW_SPIKE_FILES)) {
  await pod.fs.writeFile(path, content)
}

const writeMs = performance.now() - writeStartedAt

const installStartedAt = performance.now()

for (const [name, version] of RAW_SPIKE_PACKAGES) {
  try {
    await pod.packages.install(name, version)
  } catch (error) {
    fail(`Installing ${name}@${version} failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const installMs = performance.now() - installStartedAt

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

  await new Promise(resolve => setTimeout(resolve, 50))
}

const startupMs = performance.now() - spawnStartedAt

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
  'VFS write': ms(writeMs),
  'package install': ms(installMs),
  'startup (spawn → ready)': ms(startupMs),
  'request latency': ms(requestMs)
})
console.table({
  'installed packages': Object.keys(installed).length,
  'VFS files': memory.vfs.fileCount,
  'VFS size': `${(memory.vfs.totalBytes / 1024 / 1024).toFixed(1)} MB`,
  'module cache entries': memory.engine.moduleCacheSize,
  'processes': memory.runtime.processes,
  'heap used': memory.heap ? `${memory.heap.usedMB.toFixed(1)} MB` : 'n/a',
  'host RSS': `${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`
})

pod.teardown()
process.exit(0)
