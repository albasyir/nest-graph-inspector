import type { GraphOutput } from 'nest-graph-inspector'
import { defineStore } from 'pinia'
import { requiresVersionAcknowledgement } from '~/utils/graph-inspector-version-gate'
import {
  INSPECTOR_ACCESS_TOKEN_HEADER,
  accessTokenHeaders,
  encodeEndpointUrl,
  readAccessToken,
  redactAccessToken
} from '~/utils/inspector-access-token'
import {
  forgetAccessToken,
  readStoredAccessToken,
  storeAccessToken
} from '~/utils/inspector-access-token-storage'

type InspectorEndpointInfo = {
  'for'?: string
  'is-static'?: boolean
  'isLatestVersion'?: unknown
  'latestVersion'?: string | null
  'version'?: unknown
}

type LegacyGraphOutput = Partial<GraphOutput>
const MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION = 3

function withDefaultProtocol(input: string) {
  return input.startsWith('http://') || input.startsWith('https://')
    ? input
    : `http://${input}`
}

function normalizeSourceUrl(input: string) {
  const url = new URL(withDefaultProtocol(input.trim()))

  if (url.pathname === '/' || !url.pathname) {
    url.pathname = '/__graph-inspector'
  }

  return url.toString()
}

function appendOutputPath(value: string, fileName: string) {
  if (!value) {
    return ''
  }

  try {
    const url = new URL(value)
    const path = url.pathname.replace(/\/+$/, '')

    url.pathname = `${path}/${fileName}`
    return url.toString()
  } catch {
    return ''
  }
}

function resolveOriginPath(value: string, pathName: string) {
  if (!value) {
    return ''
  }

  try {
    const url = new URL(value)
    url.pathname = `/${pathName.replace(/^\/+/, '')}`
    url.search = ''
    url.hash = ''

    return url.toString()
  } catch {
    return ''
  }
}

/**
 * Where Direct Run lives for a given graph endpoint.
 *
 * A live application serves it at the origin root. A static graph is a
 * directory of files, so its Direct Run fixture sits beside them.
 */
function resolveDirectRunUrl(value: string, isStatic: boolean) {
  if (!value) {
    return ''
  }

  try {
    const url = new URL(value)

    url.pathname = isStatic
      ? `${url.pathname.replace(/\/$/, '')}/direct-run`
      : '/direct-run'
    url.search = ''
    url.hash = ''

    return url.toString()
  } catch {
    return ''
  }
}

function isLegacyGraphOutput(value: unknown): value is LegacyGraphOutput {
  return Boolean(
    value
    && typeof value === 'object'
    && 'version' in value
    && 'root' in value
    && 'modules' in value
  )
}

function parseGraphOutputVersion(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null
  }

  const parsedVersion = Number.parseInt(String(value), 10)
  return Number.isFinite(parsedVersion) ? parsedVersion : null
}

function isSupportedGraphOutputVersion(value: unknown): boolean {
  const parsedVersion = parseGraphOutputVersion(value)
  return (
    parsedVersion !== null
    && parsedVersion >= MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION
  )
}

/** Message the inspector returned, in preference to a generic transport error. */
function readResponseError(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return ''
  }

  const data = (error as { data?: unknown }).data
  const message = (data as { error?: unknown } | undefined)?.error

  return typeof message === 'string' ? message : ''
}

function readStatusCode(error: unknown): number {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode

  return typeof statusCode === 'number' ? statusCode : 0
}

export const useGraphInspectorStore = defineStore('graph-inspector', () => {
  /**
   * The graph endpoint being viewed, never carrying an access token.
   *
   * The token is taken out of the bootstrap link before the router ever sees it
   * (see `plugins/inspector-access-token.client.ts`), so nothing built from this
   * value — route segments, derived endpoints, analytics — can leak it.
   */
  const endpoint = ref('')

  /**
   * The credential for {@link endpoint}, sent as a request header. Empty when
   * the inspector is not token-protected.
   */
  const accessToken = ref('')

  const shouldShowUpdateModal = ref(false)
  const shouldShowVersionAcknowledgement = ref(false)
  const acknowledgedVersionEndpointUrl = ref('')
  const dependencyTraceEnabled = ref(false)
  const showCircularDependencies = ref(true)
  const openModuleDetail = ref(false)
  let resolveVersionAcknowledgement: ((acknowledged: boolean) => void) | undefined

  const endpointUrl = computed(() => endpoint.value)
  const encodedUrl = computed(() =>
    endpoint.value ? encodeEndpointUrl(endpoint.value) : ''
  )

  const informationUrl = computed(() =>
    appendOutputPath(endpoint.value, 'information.json')
  )
  const jsonUrl = computed(() =>
    appendOutputPath(endpoint.value, 'output.json')
  )
  const markdownUrl = computed(() =>
    appendOutputPath(endpoint.value, 'output.md')
  )
  const ollamaUrl = computed(() =>
    resolveOriginPath(endpoint.value, 'ollama')
  )

  /** Headers every request to the inspected application has to carry. */
  const requestHeaders = computed(() => accessTokenHeaders(accessToken.value))

  /**
   * `$fetch` that authenticates itself.
   *
   * The header is read per request rather than baked in, so a token captured
   * after a fetch was set up still applies.
   */
  const inspectorFetch = $fetch.create({
    onRequest({ options }) {
      if (!accessToken.value) {
        return
      }

      options.headers.set(INSPECTOR_ACCESS_TOKEN_HEADER, accessToken.value)
    }
  })

  const {
    data: endpointInfo,
    error: endpointInfoError,
    execute: executeEndpointInfo,
    clear: clearEndpointInfo
  } = useFetch<InspectorEndpointInfo>(() => informationUrl.value, {
    key: 'graph-inspector-endpoint-info',
    immediate: false,
    server: false,
    watch: false,
    $fetch: inspectorFetch
  })

  const {
    data: legacyGraphData,
    execute: executeLegacyGraph,
    clear: clearLegacyGraph
  } = useFetch<LegacyGraphOutput>(() => endpoint.value, {
    key: 'graph-inspector-legacy-graph',
    immediate: false,
    server: false,
    watch: false,
    $fetch: inspectorFetch
  })

  const {
    data: graphData,
    status,
    error,
    execute: executeJson,
    clear: clearJson
  } = useFetch<GraphOutput>(() => jsonUrl.value, {
    key: 'graph-inspector-json',
    immediate: false,
    server: false,
    watch: false,
    $fetch: inspectorFetch
  })

  const {
    data: graphMarkdown,
    execute: executeMarkdown,
    clear: clearMarkdown
  } = useFetch<string>(() => markdownUrl.value, {
    key: 'graph-inspector-markdown',
    default: () => '',
    immediate: false,
    server: false,
    watch: false,
    $fetch: inspectorFetch
  })

  const errorMessage = computed(
    () =>
      readResponseError(error.value)
      || readResponseError(endpointInfoError.value)
      || error.value?.message
      || ''
  )
  const graphIsStatic = computed(() => endpointInfo.value?.['is-static'] === true)
  const directRunUrl = computed(() =>
    resolveDirectRunUrl(endpoint.value, graphIsStatic.value)
  )

  /**
   * Whether the endpoint answered "you need a token".
   *
   * The token no longer lives in the URL, so this is the state a stale tab or
   * an expired session lands in, and the viewer has to say so rather than
   * report an empty graph.
   */
  const endpointRequiresAccessToken = ref(false)

  const endpointVersion = computed(() => endpointInfo.value?.version)
  const latestVersion = computed(() => {
    const version = endpointInfo.value?.latestVersion
    return typeof version === 'string' && version.trim() ? version : null
  })

  function toggleDependencyTrace() {
    dependencyTraceEnabled.value = !dependencyTraceEnabled.value
  }

  function clearGraph() {
    clearEndpointInfo()
    clearLegacyGraph()
    clearJson()
    clearMarkdown()
    shouldShowUpdateModal.value = false
    shouldShowVersionAcknowledgement.value = false
    acknowledgedVersionEndpointUrl.value = ''
    endpointRequiresAccessToken.value = false
    resolveVersionAcknowledgement?.(false)
    resolveVersionAcknowledgement = undefined
  }

  async function acknowledgeEndpointVersion() {
    acknowledgedVersionEndpointUrl.value = endpoint.value
    shouldShowVersionAcknowledgement.value = false
    resolveVersionAcknowledgement?.(true)
    resolveVersionAcknowledgement = undefined
  }

  async function ensureEndpointVersionAcknowledged() {
    if (
      !requiresVersionAcknowledgement(
        endpointInfo.value?.isLatestVersion,
        endpointInfo.value?.['is-static']
      )
      || acknowledgedVersionEndpointUrl.value === endpoint.value
    ) {
      return true
    }

    shouldShowVersionAcknowledgement.value = true
    return await new Promise<boolean>((resolve) => {
      resolveVersionAcknowledgement = resolve
    })
  }

  /** Takes custody of a token read out of a bootstrap link. */
  function rememberAccessToken(forEndpointUrl: string, token: string) {
    if (!forEndpointUrl || !token) {
      return
    }

    storeAccessToken(forEndpointUrl, token)

    if (forEndpointUrl === endpoint.value) {
      accessToken.value = token
    }
  }

  /** Points the store at a graph endpoint, recovering the token it needs. */
  function applyEndpoint(nextEndpointUrl: string) {
    if (endpoint.value !== nextEndpointUrl) {
      endpoint.value = nextEndpointUrl
      clearGraph()
    }

    accessToken.value = readStoredAccessToken(nextEndpointUrl)
  }

  /**
   * Drops a credential the inspector refused.
   *
   * Keeping it would mean every reload replays a dead token, and repeated
   * invalid tokens are what the library's brute-force lockout counts.
   */
  function discardRejectedAccessToken() {
    endpointRequiresAccessToken.value = true

    if (!accessToken.value) {
      return
    }

    accessToken.value = ''
    forgetAccessToken(endpoint.value)
  }

  async function validateEndpoint() {
    if (!informationUrl.value) {
      clearEndpointInfo()
      return false
    }

    await executeEndpointInfo()

    const isValidEndpoint = endpointInfo.value?.for === 'nest-graph-inspector'
    if (isValidEndpoint) {
      shouldShowUpdateModal.value = false
      endpointRequiresAccessToken.value = false
      return true
    }

    if (readStatusCode(endpointInfoError.value) === 401) {
      discardRejectedAccessToken()
      return false
    }

    await executeLegacyGraph()
    shouldShowUpdateModal.value = isLegacyGraphOutput(legacyGraphData.value)

    return false
  }

  async function fetchJson() {
    if (!jsonUrl.value) {
      clearJson()
      return false
    }

    await executeJson()
    if (status.value !== 'success') {
      shouldShowUpdateModal.value = false

      if (readStatusCode(error.value) === 401) {
        discardRejectedAccessToken()
      }

      return false
    }

    const hasSupportedVersion = isSupportedGraphOutputVersion(
      graphData.value?.version
    )

    shouldShowUpdateModal.value = !hasSupportedVersion
    return hasSupportedVersion
  }

  async function fetchMarkdown() {
    if (!markdownUrl.value) {
      clearMarkdown()
      return false
    }

    await executeMarkdown()
    return Boolean(graphMarkdown.value)
  }

  async function setEndpoint(nextEndpointUrl: string) {
    applyEndpoint(nextEndpointUrl)

    const isValidEndpoint = await validateEndpoint()
    if (!isValidEndpoint) {
      return false
    }

    if (!await ensureEndpointVersionAcknowledged()) {
      return false
    }

    return await fetchJson()
  }

  /**
   * Splits typed or pasted input into an endpoint and a token, so pasting a
   * full inspector URL works without putting its token back into a URL.
   */
  function splitSourceUrl(input: string) {
    const sourceUrl = normalizeSourceUrl(input)
    const token = readAccessToken(sourceUrl)

    return {
      endpointUrl: token ? redactAccessToken(sourceUrl) : sourceUrl,
      token
    }
  }

  async function setInputUrl(input: string) {
    const { endpointUrl: sourceUrl, token } = splitSourceUrl(input)

    rememberAccessToken(sourceUrl, token ?? '')

    return await setEndpoint(sourceUrl)
  }

  async function detectInputUrl(input: string) {
    const { endpointUrl: sourceUrl, token } = splitSourceUrl(input)

    rememberAccessToken(sourceUrl, token ?? '')
    applyEndpoint(sourceUrl)

    return await validateEndpoint()
  }

  async function fetchGraph() {
    const isValidEndpoint = await validateEndpoint()
    if (!isValidEndpoint) {
      return false
    }

    if (!await ensureEndpointVersionAcknowledged()) {
      return false
    }

    const jsonLoaded = await fetchJson()
    if (jsonLoaded) {
      await fetchMarkdown()
    }

    return jsonLoaded
  }

  return {
    // `accessToken` itself is deliberately not exposed: callers get
    // `requestHeaders`, so there is no way to put the raw credential anywhere
    // other than a request header.
    requestHeaders,
    encodedUrl,
    endpointUrl,
    informationUrl,
    jsonUrl,
    markdownUrl,
    ollamaUrl,
    directRunUrl,
    graphData,
    graphMarkdown,
    graphIsStatic,
    endpointVersion,
    endpointRequiresAccessToken,
    latestVersion,
    status,
    error,
    errorMessage,
    shouldShowUpdateModal,
    shouldShowVersionAcknowledgement,
    dependencyTraceEnabled,
    showCircularDependencies,
    openModuleDetail,
    toggleDependencyTrace,
    rememberAccessToken,
    validateEndpoint,
    acknowledgeEndpointVersion,
    setEndpoint,
    setInputUrl,
    detectInputUrl,
    fetchJson,
    fetchMarkdown,
    fetchGraph
  }
})
