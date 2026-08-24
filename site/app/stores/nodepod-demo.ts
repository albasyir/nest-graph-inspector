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
  const logLines = ref<string[]>([])
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
  let graphPromise: Promise<GraphOutput | null> | undefined
  let bridgedFetch: FetchLike | undefined
  let originalFetch: FetchLike | undefined
  let logBuffer = ''
  let exitCode: number | undefined

  const isRunning = computed(() => status.value === 'ready')
  const isBusy = computed(
    () => status.value === 'downloading'
      || status.value === 'booting'
      || status.value === 'starting'
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

  function siteBaseUrl() {
    const base = config.app.baseURL || '/'

    return new URL(
      base.endsWith('/') ? base : `${base}/`,
      window.location.origin
    ).toString()
  }

  function payloadUrl(fileName: string, revision?: string) {
    const url = new URL(`nodepod-demo/${fileName}`, siteBaseUrl())

    if (revision) {
      url.searchParams.set('v', revision)
    }

    return url.toString()
  }

  function appendLog(text: string) {
    logBuffer += stripAnsi(text)

    const lines = logBuffer.split('\n')
    logBuffer = lines.pop() ?? ''

    if (!lines.length) {
      return
    }

    const next = [...logLines.value, ...lines]
    logLines.value = next.slice(Math.max(0, next.length - MAX_LOG_LINES))
  }

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
    const declaredLength = Number(response.headers.get('content-length'))
    totalBytes.value = expectedBytes
      || (Number.isFinite(declaredLength) ? declaredLength : 0)

    if (!response.body) {
      const text = await response.text()
      downloadedBytes.value = text.length

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

  function removeFetchBridge() {
    if (bridgedFetch && window.fetch === bridgedFetch && originalFetch) {
      window.fetch = originalFetch
    }

    bridgedFetch = undefined
    originalFetch = undefined
  }

  async function waitForEndpoint(): Promise<string> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS

    while (Date.now() < deadline) {
      const endpoint = readViewerLinkEndpoint(
        [...logLines.value, logBuffer].join('\n')
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

  async function run(): Promise<boolean> {
    // A previous attempt may have booted a pod and installed a bridge before
    // failing; starting again on top of those would leak the pod and stack a
    // second bridge over the first.
    disposePod()

    status.value = 'downloading'
    errorMessage.value = ''
    logLines.value = []
    logBuffer = ''
    exitCode = undefined
    downloadedBytes.value = 0
    totalBytes.value = 0

    const demoManifest = await fetchManifest()
    manifest.value = demoManifest

    const [bundle, sources] = await Promise.all([
      fetchBundle(
        payloadUrl(demoManifest.entry, demoManifest.revision),
        demoManifest.bundleBytes
      ),
      fetch(payloadUrl(demoManifest.sources, demoManifest.revision), {
        cache: 'force-cache'
      }).then(response => response.json() as Promise<Record<string, string>>)
    ])

    const files: Record<string, string> = {
      [`${demoManifest.workdir}/${demoManifest.entry}`]: bundle
    }

    for (const [path, content] of Object.entries(sources)) {
      files[`${demoManifest.workdir}/${path}`] = content
    }

    status.value = 'booting'

    const { Nodepod: NodepodRuntime } = await import('@scelar/nodepod')

    pod = await NodepodRuntime.boot({
      files,
      workdir: demoManifest.workdir,
      env: {
        ...demoManifest.env,
        /**
         * The application prints its viewer link with this base, so the link
         * in the demo console is a link into the site the visitor is on.
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

    installFetchBridge(pod)

    status.value = 'starting'

    const demoProcess = await pod.spawn('node', [demoManifest.entry], {
      cwd: demoManifest.workdir
    })

    demoProcess.on('output', appendLog)
    demoProcess.on('error', appendLog)
    demoProcess.on('exit', (code) => {
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

    const printedEndpoint = await waitForEndpoint()

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
   * serves every preview and the viewer, so the payload is downloaded and the
   * application booted at most once per page load.
   */
  function start(): Promise<boolean> {
    if (!import.meta.client) {
      return Promise.resolve(false)
    }

    if (status.value === 'ready') {
      return Promise.resolve(true)
    }

    startPromise ??= run().catch((error: unknown) => {
      status.value = 'error'
      errorMessage.value = error instanceof Error
        ? error.message
        : 'The demo application could not be started.'
      startPromise = undefined

      return false
    })

    return startPromise
  }

  /**
   * Fetches the graph the running application reports, once, for every preview
   * that asks for it.
   */
  function loadGraphOutput(): Promise<GraphOutput | null> {
    graphPromise ??= start()
      .then(async (started) => {
        if (!started) {
          // Remembering a failed start would leave every preview mounted
          // afterwards looking at a cached null, even once the demo runs.
          graphPromise = undefined

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

        graphPromise = undefined

        return null
      })

    return graphPromise
  }

  function disposePod() {
    removeFetchBridge()
    pod?.teardown()
    pod = undefined
    exitCode = undefined
  }

  function stop() {
    disposePod()
    startPromise = undefined
    graphPromise = undefined
    graphOutput.value = null
    endpointUrl.value = ''
    accessToken.value = ''
    status.value = 'idle'
  }

  return {
    status,
    errorMessage,
    logLines,
    manifest,
    endpointUrl,
    accessToken,
    requestHeaders,
    graphOutput,
    directRunUrl,
    isRunning,
    isBusy,
    statusLabel,
    downloadedBytes,
    totalBytes,
    downloadProgress,
    start,
    loadGraphOutput,
    stop
  }
})
