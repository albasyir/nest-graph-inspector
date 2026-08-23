/**
 * Boots the demo payload the way the site does and checks that it answers.
 *
 * This is the only thing that exercises the two couplings the in-browser demo
 * rests on: that the bundled `nest build` output starts under the runtime at
 * all, and that the site can still find the graph endpoint in the application's
 * startup log. The second one is a contract with the library — the viewer link
 * it prints — and it is checked here with the site's own parser rather than a
 * copy of it, so a reworded log line or a changed link shape fails here instead
 * of in a visitor's browser.
 *
 * The browser runs it headless on Web Workers; this runs the same runtime on
 * worker_threads. Requires the payload to exist:
 *   pnpm --filter nest-graph-inspector-demo run build:nodepod
 */
import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Nodepod } from '@scelar/nodepod/headless'
import { readViewerLinkEndpoint } from '../app/utils/nodepod-demo-endpoint.ts'

/**
 * Ceiling on the bundled application, so a dependency that doubles what every
 * visitor downloads cannot land unnoticed.
 */
const MAX_BUNDLE_BYTES = 24 * 1024 * 1024
const STARTUP_TIMEOUT_MS = 120_000

type Manifest = {
  payloadVersion: number
  workdir: string
  entry: string
  sources: string
  env: Record<string, string>
  bundleBytes: number
}

const payloadDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../public/nodepod-demo'
)

async function readManifest(): Promise<Manifest> {
  try {
    return JSON.parse(
      await readFile(join(payloadDir, 'manifest.json'), 'utf8')
    ) as Manifest
  } catch {
    throw new Error(
      `No demo payload at ${payloadDir}. Build it with "pnpm --filter nest-graph-inspector-demo run build:nodepod".`
    )
  }
}

const manifest = await readManifest()
assert.equal(manifest.payloadVersion, 1, 'unexpected payload version')
assert.ok(
  manifest.bundleBytes < MAX_BUNDLE_BYTES,
  `bundle is ${(manifest.bundleBytes / 1024 / 1024).toFixed(1)} MB, over the ${MAX_BUNDLE_BYTES / 1024 / 1024} MB ceiling`
)

const sources = JSON.parse(
  await readFile(join(payloadDir, manifest.sources), 'utf8')
) as Record<string, string>
const files: Record<string, string> = {
  [`${manifest.workdir}/${manifest.entry}`]: await readFile(
    join(payloadDir, manifest.entry),
    'utf8'
  )
}

for (const [path, content] of Object.entries(sources)) {
  files[`${manifest.workdir}/${path}`] = content
}

const startedAt = Date.now()
const pod = await Nodepod.boot({
  files,
  workdir: manifest.workdir,
  env: { ...manifest.env, ____DEV_VIEWER_BASE_URL: 'http://localhost:3000' }
})

let log = ''
let exitCode: number | undefined
const demoProcess = await pod.spawn('node', [manifest.entry], {
  cwd: manifest.workdir
})

demoProcess.on('output', (chunk: string) => {
  log += chunk
})
demoProcess.on('error', (chunk: string) => {
  log += chunk
})
demoProcess.on('exit', (code: number) => {
  exitCode = code
})

function fail(message: string): never {
  console.error(`${message}\n\n--- demo application output ---\n${log}`)
  pod.teardown()
  process.exit(1)
}

let endpoint: string | null = null

while (Date.now() - startedAt < STARTUP_TIMEOUT_MS) {
  endpoint = readViewerLinkEndpoint(log)

  if (endpoint) {
    break
  }

  if (exitCode !== undefined) {
    fail(`The demo application exited with code ${exitCode} before printing a viewer link.`)
  }

  await new Promise(resolve => setTimeout(resolve, 100))
}

if (!endpoint) {
  fail('The demo application printed no viewer link the site could read.')
}

const endpointUrl = new URL(endpoint)
assert.ok(
  endpointUrl.searchParams.get('__inspector_token'),
  'the viewer link carried no access token'
)

async function call(path: string, headers?: Record<string, string>) {
  const response = await pod.request(Number(endpointUrl.port), { path, headers })

  return {
    status: response.statusCode,
    body: Buffer.from(response.body ?? []).toString()
  }
}

// Authenticated with the header, because that is what the site sends: it takes
// the token out of the printed link and never puts it back into a URL.
const graphPath = `${endpointUrl.pathname}/output.json`
const graph = await call(graphPath, {
  'x-graph-inspector-token': endpointUrl.searchParams.get('__inspector_token') ?? ''
})

if (graph.status !== 200) {
  fail(`${graphPath} answered ${graph.status}`)
}

const parsed = JSON.parse(graph.body) as {
  root: string
  modules: Record<string, { providers: { name: string }[] }>
}

assert.equal(parsed.root, 'AppModule')
assert.ok(
  parsed.modules.UserModule?.providers.some(
    provider => provider.name === 'UserService'
  ),
  'UserService is missing from the graph, so dependency metadata did not survive the bundle'
)

// Without an access token the endpoint has to refuse, in the browser as anywhere.
const unauthorized = await call(graphPath)
assert.equal(unauthorized.status, 401, 'the endpoint answered without a token')

console.log(
  `nodepod payload ok: ${Object.keys(parsed.modules).length} modules, `
  + `${(manifest.bundleBytes / 1024 / 1024).toFixed(1)} MB bundle, `
  + `viewer link after ${Date.now() - startedAt} ms`
)

pod.teardown()
process.exit(0)
