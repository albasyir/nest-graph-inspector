import type { Nodepod } from '@scelar/nodepod'
import type { GraphOutput } from 'nest-graph-inspector'
import { defineStore } from 'pinia'
import {
  buildDemoEndpointUrl,
  readDemoRequestTarget,
  readViewerLinkEndpoint
} from '~/utils/nodepod-demo-endpoint'
import {
  accessTokenHeaders,
  readAccessToken,
  redactAccessToken
} from '~/utils/inspector-access-token'
import { resolveDirectRunUrl } from '~/utils/inspector-endpoint-url'
import { createNodepodDemoRunGuard } from '~/utils/nodepod-demo-run-guard'
import {
  stripAnsi,
  toRequestBody,
  toResponseBody,
  toResponseHeaders,
  withDeadline
} from '~/utils/nodepod-demo-bridge'

/**
 * Manifest written by `demo/scripts/build-nodepod-payload.ts`.
 */
type DemoManifest = {
  payloadVersion: number
  revision: string
  builtAt: string
  demoVersion: string
  libraryVersion: string
  workdir: string
  entry: string
  sources: string
  snapshot?: string
  snapshotBytes?: number
  env: Record<string, string>
  bundleBytes: number
  sourceFileCount: number
}

export type NodepodDemoStatus
  = | 'idle'
    | 'downloading'
    | 'booting'
    | 'starting'
    | 'ready'
    | 'error'

const SUPPORTED_PAYLOAD_VERSION = 1
const STARTUP_TIMEOUT_MS = 120_000
const MAX_LOG_LINES = 500

type FetchLike = typeof globalThis.fetch

export const useNodepodDemoStore = defineStore('nodepod-demo', () => {
  const config = useRuntimeConfig()

  const status = ref<NodepodDemoStatus>('idle')
  const errorMessage = ref('')
  const downloadedBytes = ref(0)
  const totalBytes = ref(0)
  const manifest = ref<DemoManifest | null>(null)
  /** Graph endpoint of the running application, never carrying a token. */
  const endpointUrl = ref('')
  /**
   * Token the application printed for itself. The viewer sends it as a header,
   * exactly as it does for an application on the developer's own machine.
   */
  const accessToken = ref('')
  const graphOutput = ref<GraphOutput | null>(null)

  let pod: Nodepod | undefined
  let startPromise: Promise<boolean> | undefined
  /**
   * The graph request every preview shares. Held in a ref rather than a plain
   * variable so {@link isLoadingGraph} can follow it: between the application
   * reporting `ready` and its graph arriving, nothing else says a request is
   * still in flight.
   */
  const graphPromise = shallowRef<Promise<GraphOutput | null>>()
  let bridgedFetch: FetchLike | undefined
  let originalFetch: FetchLike | undefined
  /**
   * What the application printed, kept only to read its viewer link from and
   * never shown: the visitor sees the store's status and error messages.
   */
  let logLines: string[] = []
  let logBuffer = ''
  let exitCode: number | undefined
  /**
   * Which startup the shared state below belongs to. Tearing the pod down
   * supersedes the run that owned it, so a run resuming afterwards can see
   * that it is no longer the one being waited on and stand down instead of
   * publishing itself over its successor.
   */
  const runs = createNodepodDemoRunGuard()

  const isRunning = computed(() => status.value === 'ready')
  const isBusy = computed(
    () => status.value === 'downloading'
      || status.value === 'booting'
      || status.value === 'starting'
  )
  /** The graph has been asked for and has neither arrived nor failed yet. */
  const isLoadingGraph = computed(
    () => Boolean(graphPromise.value) && !graphOutput.value
  )
  /** Direct-run endpoint of the running application, and what authenticates it. */
  const directRunUrl = computed(() => resolveDirectRunUrl(endpointUrl.value, false))
  const requestHeaders = computed(() => accessTokenHeaders(accessToken.value))

  const downloadProgress = computed(() => {
    if (!totalBytes.value) {
      return 0
    }

    return Math.min(1, downloadedBytes.value / totalBytes.value)
  })

  /**
   * What the runtime is busy with, in the words the visitor is waiting on.
   */
  const statusLabel = computed(() => {
    switch (status.value) {
      case 'downloading': {
        const percentage = Math.round(downloadProgress.value * 100)

        return percentage
          ? `Downloading the demo application… ${percentage}%`
          : 'Downloading the demo application…'
      }
      case 'booting':
        return 'Booting the Node runtime in your browser…'
      case 'starting':
        return 'Starting the NestJS application…'
      case 'ready':
        return 'The demo application is running in your browser.'
      case 'error':
        return errorMessage.value
      default:
        return 'Starting the demo application…'
    }
  })

  /**
   * Absolute URL the site itself is served from, with a trailing slash so it
   * can be used as a base. GitHub Pages serves this site from a subpath, so
   * the origin alone would resolve the payload against the wrong root.
   */
  function siteBaseUrl() {
    const base = config.app.baseURL || '/'

    return new URL(
      base.endsWith('/') ? base : `${base}/`,
      window.location.origin
    ).toString()
  }

  /**
   * URL of one file in the published payload.
   *
   * The revision from the manifest is carried as a query parameter so a cached
   * bundle is never paired with the sources or vendor snapshot of a different
   * build; the payload build derives it from all three.
   */
  function payloadUrl(fileName: string, revision?: string) {
    const url = new URL(`nodepod-demo/${fileName}`, siteBaseUrl())

    if (revision) {
      url.searchParams.set('v', revision)
    }

    return url.toString()
  }

  /**
   * Adds a chunk of application output to the log the viewer link is read from.
   *
   * The runtime hands over whatever it has, which may stop mid-line, so a
   * trailing partial line is held back until the rest of it arrives. Only the
   * most recent {@link MAX_LOG_LINES} are kept.
   */
  function appendLog(text: string) {
    logBuffer += stripAnsi(text)

    const lines = logBuffer.split('\n')
    logBuffer = lines.pop() ?? ''

    if (!lines.length) {
      return
    }

    const next = [...logLines, ...lines]
    logLines = next.slice(Math.max(0, next.length - MAX_LOG_LINES))
  }

  /**
   * Downloads the payload manifest and checks this viewer can read it.
   *
   * Fetched uncached, because it is the file that says which revision the
   * cached ones must match.
   */
  async function fetchManifest(): Promise<DemoManifest> {
    const response = await fetch(payloadUrl('manifest.json'), {
      cache: 'no-cache'
    })
    const parsed = response.ok
      ? ((await response.json().catch(() => null)) as DemoManifest | null)
      : null

    // Checked rather than assumed, because a host that answers a missing file
    // with its own page — a 404 body served as 200 — would otherwise surface as
    // a JSON parse error, which says nothing about what is missing.
    if (!parsed || typeof parsed.payloadVersion !== 'number') {
      throw new Error(
        `The demo payload is not published on this site (${response.status}). Build it with "pnpm --filter nest-graph-inspector-demo run build:nodepod".`
      )
    }

    if (parsed.payloadVersion !== SUPPORTED_PAYLOAD_VERSION) {
      throw new Error(
        `The demo payload is version ${parsed.payloadVersion}, and this viewer reads version ${SUPPORTED_PAYLOAD_VERSION}.`
      )
    }

    return parsed
  }

  /**
   * Reads the bundle as a stream so the progress shown to the visitor is the
   * download that is actually holding them up.
   */
  async function fetchBundle(url: string, expectedBytes: number): Promise<string> {
    const response = await fetch(url, { cache: 'force-cache' })

    if (!response.ok) {
      throw new Error(`Could not download the demo application (${response.status}).`)
    }

    // The manifest records the size of the file itself. Content-Length is the
    // size on the wire, which is the compressed one wherever the host
    // compresses, and counting decompressed bytes against it reads as done
    // long before it is.
    if (!totalBytes.value) {
      const declaredLength = Number(response.headers.get('content-length'))
      totalBytes.value = expectedBytes
        || (Number.isFinite(declaredLength) ? declaredLength : 0)
    }

    if (!response.body) {
      const text = await response.text()
      downloadedBytes.value += text.length

      return text
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''

    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      downloadedBytes.value += value.byteLength
      text += decoder.decode(value, { stream: true })
    }

    return text + decoder.decode()
  }

  /**
   * Reads the prebuilt vendor snapshot as a byte buffer.
   */
  async function fetchSnapshot(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url, { cache: 'force-cache' })

    if (!response.ok) {
      throw new Error(`Could not download the vendor snapshot (${response.status}).`)
    }

    if (!response.body) {
      const buffer = await response.arrayBuffer()
      downloadedBytes.value += buffer.byteLength

      return buffer
    }

    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0

    for (;;) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      chunks.push(value)
      received += value.byteLength
      downloadedBytes.value += value.byteLength
    }

    const combined = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }

    return combined.buffer
  }

  /**
   * The demo's own sources, which the library's source reader needs to report
   * JSDoc and Direct Run parameter types.
   *
   * Checked before parsing for the same reason the manifest is: a host that
   * answers a missing file with its own page would otherwise surface as a JSON
   * syntax error, which tells the visitor nothing about what is missing.
   */
  async function fetchSources(url: string): Promise<Record<string, string>> {
    const response = await fetch(url, { cache: 'force-cache' })
    const parsed = response.ok
      ? ((await response.json().catch(() => null)) as Record<
          string,
          string
        > | null)
      : null

    if (!parsed) {
      throw new Error(
        `Could not read the demo application's sources (${response.status}).`
      )
    }

    return parsed
  }

  /**
   * Routes the viewer's own requests to the virtual servers running in this
   * tab. Everything else is handed straight to the browser.
   */
  function installFetchBridge(instance: Nodepod) {
    const base = siteBaseUrl()
    const previousFetch = window.fetch.bind(window)
    originalFetch = previousFetch

    const bridge: FetchLike = async (input, init) => {
      const request = input instanceof Request ? input : undefined
      const url = request?.url
        ?? (input instanceof URL ? input.toString() : String(input))
      const target = readDemoRequestTarget(url, base)

      if (!target) {
        return previousFetch(input, init)
      }

      const method = init?.method ?? request?.method ?? 'GET'
      const headers = new Headers(init?.headers ?? request?.headers)
      const body = init?.body !== undefined
        ? toRequestBody(init.body)
        : request && method !== 'GET' && method !== 'HEAD'
          ? await request.clone().text()
          : undefined

      try {
        const response = await withDeadline(
          instance.request(target.port, {
            method,
            path: target.path,
            headers: Object.fromEntries(headers.entries()),
            body: body ?? null
          }),
          init?.signal ?? request?.signal ?? null
        )

        return new Response(
          toResponseBody(response.body, response.statusCode),
          {
            status: response.statusCode,
            statusText: response.statusMessage,
            headers: toResponseHeaders(response.headers)
          }
        )
      } catch (error) {
        return new Response(
          error instanceof Error ? error.message : 'Demo request failed',
          { status: 502, statusText: 'Demo Runtime Error' }
        )
      }
    }

    bridgedFetch = bridge
    window.fetch = bridge
  }

  /**
   * Puts the browser's own `fetch` back.
   *
   * Only when the bridge installed here is still the one in place: something
   * else may have wrapped `fetch` since, and restoring over that would undo
   * its work rather than this one's.
   */
  function removeFetchBridge() {
    if (bridgedFetch && window.fetch === bridgedFetch && originalFetch) {
      window.fetch = originalFetch
    }

    bridgedFetch = undefined
    originalFetch = undefined
  }

  /**
   * Waits for the application to print its viewer link, and returns the graph
   * endpoint read out of it — or `null` once this startup has been superseded.
   *
   * Polls the log rather than the port, because the link is the only place the
   * access token is handed out. Gives up at {@link STARTUP_TIMEOUT_MS}, or as
   * soon as the application exits.
   */
  async function waitForEndpoint(isCurrentRun: () => boolean): Promise<string | null> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS

    while (Date.now() < deadline) {
      // The log being read is the store's, and a newer startup writes to the
      // same one: keeping the poll running would read its lines as this run's.
      if (!isCurrentRun()) {
        return null
      }

      const endpoint = readViewerLinkEndpoint(
        [...logLines, logBuffer].join('\n')
      )

      if (endpoint) {
        return endpoint
      }

      // An application that has already exited is never going to print one,
      // so waiting out the timeout would only delay the error.
      if (exitCode !== undefined) {
        throw new Error(
          `The demo application exited with code ${exitCode} before it reported a graph endpoint.`
        )
      }

      await new Promise(resolve => setTimeout(resolve, 150))
    }

    throw new Error(
      'The demo application did not report a graph endpoint in time.'
    )
  }

  /**
   * Downloads the payload, boots the runtime, spawns the application and reads
   * its endpoint — the whole startup, driving `status` as it goes.
   *
   * Resolves to whether the demo came up; the reason it did not is left in
   * `errorMessage` rather than thrown, since every caller shows it.
   */
  async function run(): Promise<boolean> {
    // A previous attempt may have booted a pod and installed a bridge before
    // failing; starting again on top of those would leak the pod and stack a
    // second bridge over the first.
    disposePod()

    // Claimed after the teardown above, which is what superseded the run
    // before it. Every await below is a point at which a stop or a restart can
    // come in behind this run, and nothing it owns may be published once one
    // has.
    const isCurrentRun = runs.claim()

    status.value = 'downloading'
    errorMessage.value = ''
    logLines = []
    logBuffer = ''
    exitCode = undefined
    downloadedBytes.value = 0
    totalBytes.value = 0

    const demoManifest = await fetchManifest()

    if (!isCurrentRun()) {
      return false
    }

    manifest.value = demoManifest

    totalBytes.value = demoManifest.bundleBytes + (demoManifest.snapshotBytes ?? 0)

    const [bundle, sources, snapshotData] = await Promise.all([
      fetchBundle(
        payloadUrl(demoManifest.entry, demoManifest.revision),
        demoManifest.bundleBytes
      ),
      fetchSources(payloadUrl(demoManifest.sources, demoManifest.revision)),
      demoManifest.snapshot
        ? fetchSnapshot(
            payloadUrl(demoManifest.snapshot, demoManifest.revision)
          )
        : Promise.resolve(null)
    ])

    if (!isCurrentRun()) {
      return false
    }

    status.value = 'booting'

    const { Nodepod: NodepodRuntime } = await import('@scelar/nodepod')

    const booted = await NodepodRuntime.boot({
      workdir: demoManifest.workdir,
      env: {
        ...demoManifest.env,
        /**
         * The application prints its viewer link with this base, so the link
         * it logs points into the site the visitor is on.
         */
        ____DEV_VIEWER_BASE_URL: siteBaseUrl().replace(/\/+$/, '')
      },
      /**
       * Headless keeps the runtime off the Service Worker, which registers at
       * the origin root and cannot be granted that scope on GitHub Pages.
       * Requests reach the virtual servers through the fetch bridge instead.
       */
      headless: true,
      /**
       * The payload is self-contained, so the runtime installs no packages and
       * has nothing to cache. Keeping both stores in memory drops a dependency
       * on IndexedDB, which private browsing modes can refuse outright.
       */
      enableSnapshotCache: false,
      packageStore: 'memory'
    })

    // The boot is the longest await in the startup, so it is the likeliest to
    // be outlived. Its pod is torn down here rather than published: the store
    // already belongs to a newer run, whose own pod would be lost by the
    // assignment and left running with nothing pointing at it.
    if (!isCurrentRun()) {
      booted.teardown()

      return false
    }

    // Until it is published as `pod`, this run is the only thing holding the
    // pod, and disposePod() cannot reach it: a failure here tears it down
    // before passing the error on, or it would be left running.
    try {
      if (snapshotData) {
        const { decodeRawSpikeSnapshot } = await import('~/utils/raw-nestjs-spike')
        const { snapshot } = await decodeRawSpikeSnapshot(snapshotData)
        await booted.restore({ entries: snapshot.entries }, { autoInstall: false })
      }

      if (!isCurrentRun()) {
        booted.teardown()

        return false
      }

      await booted.fs.writeFile(
        `${demoManifest.workdir}/${demoManifest.entry}`,
        bundle
      )

      for (const [path, content] of Object.entries(sources)) {
        await booted.fs.writeFile(`${demoManifest.workdir}/${path}`, content)
      }
    } catch (error) {
      booted.teardown()

      throw error
    }

    pod = booted

    installFetchBridge(booted)

    status.value = 'starting'

    const demoProcess = await booted.spawn('node', [demoManifest.entry], {
      cwd: demoManifest.workdir
    })

    if (!isCurrentRun()) {
      return false
    }

    demoProcess.on('output', appendLog)
    demoProcess.on('error', appendLog)
    demoProcess.on('exit', (code) => {
      // A torn-down pod's process still reports its exit, and by then the log
      // and the status belong to whatever replaced it.
      if (!isCurrentRun()) {
        return
      }

      exitCode = code
      appendLog(`\nDemo application exited with code ${code}\n`)

      /**
       * Its virtual servers are registered with the runtime rather than with
       * the process, so a graph that already loaded keeps working and the exit
       * is only news while the demo is still starting.
       */
      if (status.value !== 'ready' && status.value !== 'error') {
        status.value = 'error'
        errorMessage.value = `The demo application stopped (exit code ${code}).`
      }
    })

    const printedEndpoint = await waitForEndpoint(isCurrentRun)

    if (printedEndpoint === null || !isCurrentRun()) {
      return false
    }

    // The printed link is a bootstrap credential: the endpoint keeps the path,
    // the token comes out of the URL and stays out of every URL after it.
    endpointUrl.value = buildDemoEndpointUrl({
      endpointUrl: redactAccessToken(printedEndpoint),
      siteBaseUrl: siteBaseUrl()
    })
    accessToken.value = readAccessToken(printedEndpoint) ?? ''
    status.value = 'ready'

    return true
  }

  /**
   * Starts the demo application, or joins the start already in flight. One pod
   * serves every preview and the viewer, so nothing downloads the payload or
   * boots the application while one is already running: a second boot needs the
   * one before it to have failed or been stopped.
   */
  function start(): Promise<boolean> {
    if (!import.meta.client) {
      return Promise.resolve(false)
    }

    if (status.value === 'ready') {
      return Promise.resolve(true)
    }

    if (!startPromise) {
      const attempt = run()
      // run() tears the previous pod down before its first await, so a claim
      // taken here is this attempt's own.
      const isCurrentRun = runs.claim()

      startPromise = attempt.catch((error: unknown) => {
        // A startup that was stopped or restarted while it was failing is not
        // the one the visitor is waiting on, and its message would land on top
        // of whatever replaced it.
        if (!isCurrentRun()) {
          return false
        }

        // The failure may have come after the pod booted or the bridge went in,
        // and nothing else will reach them: start() is the only caller, and it
        // will not run again unless the visitor asks.
        disposePod()

        status.value = 'error'
        errorMessage.value = error instanceof Error
          ? error.message
          : 'The demo application could not be started.'
        startPromise = undefined

        return false
      })
    }

    return startPromise
  }

  /**
   * Fetches the graph the running application reports, once, for every preview
   * that asks for it.
   */
  function loadGraphOutput(): Promise<GraphOutput | null> {
    if (graphPromise.value) {
      return graphPromise.value
    }

    const request = start()
      .then(async (started) => {
        if (!started) {
          // Remembering a failed start would leave every preview mounted
          // afterwards looking at a cached null, even once the demo runs.
          graphPromise.value = undefined

          return null
        }

        const url = new URL(endpointUrl.value)
        url.pathname = `${url.pathname.replace(/\/+$/, '')}/output.json`

        const response = await fetch(url.toString(), {
          headers: requestHeaders.value
        })

        if (!response.ok) {
          throw new Error(
            `The demo graph endpoint answered ${response.status}.`
          )
        }

        graphOutput.value = (await response.json()) as GraphOutput

        return graphOutput.value
      })
      .catch((error: unknown) => {
        if (status.value !== 'error') {
          status.value = 'error'
          errorMessage.value = error instanceof Error
            ? error.message
            : 'The demo graph could not be read.'
        }

        graphPromise.value = undefined

        return null
      })

    graphPromise.value = request

    return request
  }

  /**
   * Tears the runtime down and unbridges `fetch`, leaving no virtual server
   * for a request to be routed to.
   */
  function disposePod() {
    removeFetchBridge()
    pod?.teardown()
    pod = undefined
    exitCode = undefined

    // The endpoint and the token go with the pod that answered them: a torn
    // down pod leaves an address nothing is listening on and a credential
    // nothing will accept, and a startup that fails before publishing its own
    // would otherwise leave the dead pod's still readable.
    endpointUrl.value = ''
    accessToken.value = ''

    // Whatever startup owned that pod no longer owns the store.
    runs.supersede()
  }

  /** Puts the demo back to waiting after a failure has been read. */
  function dismissError() {
    if (status.value === 'error') {
      status.value = 'idle'
      errorMessage.value = ''
    }
  }

  /**
   * Disposes the running application and puts the store back to waiting.
   *
   * The session goes with the pod, in {@link disposePod}; what is cleared here
   * is everything that described the demo as something the viewer could still
   * be shown.
   */
  function stop() {
    disposePod()
    startPromise = undefined
    graphPromise.value = undefined
    graphOutput.value = null
    status.value = 'idle'
  }

  /**
   * Waits for the demo application this tab is already running or starting,
   * and never boots one: resolves to whether it is up, and to `false` straight
   * away when nothing was started.
   *
   * For the pages that may only reuse the demo — `/view` and the viewer pages
   * below it — so that asking for it can never be what starts it.
   */
  function join(): Promise<boolean> {
    if (status.value === 'ready') {
      return Promise.resolve(true)
    }

    return startPromise ?? Promise.resolve(false)
  }

  return {
    status,
    errorMessage,
    manifest,
    endpointUrl,
    accessToken,
    requestHeaders,
    graphOutput,
    directRunUrl,
    isRunning,
    isBusy,
    isLoadingGraph,
    statusLabel,
    downloadedBytes,
    totalBytes,
    downloadProgress,
    start,
    join,
    loadGraphOutput,
    dismissError,
    stop
  }
})
