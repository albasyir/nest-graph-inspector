import type { GraphOutput } from 'nest-graph-inspector'
import { defineStore } from 'pinia'
import { requiresVersionAcknowledgement } from '~/utils/graph-inspector-version-gate'
import {
  INSPECTOR_ACCESS_TOKEN_HEADER,
  accessTokenHeaders,
  readAccessToken,
  redactAccessToken
} from '~/utils/inspector-access-token'
import {
  isLegacyGraphOutput,
  isSupportedGraphOutputVersion,
  type LegacyGraphOutput
} from '~/utils/graph-output-support'
import { readResponseError, readStatusCode } from '~/utils/http-error'
import {
  appendOutputPath,
  normalizeSourceUrl,
  resolveDirectRunUrl,
  resolveOriginPath
} from '~/utils/inspector-endpoint-url'
import {
  readGraphSession,
  writeGraphSession
} from '~/utils/inspector-graph-session'
import { resolveInspectorMountBase } from '~/utils/nodepod-demo-endpoint'

type InspectorEndpointInfo = {
  'for'?: string
  'is-static'?: boolean
  'isLatestVersion'?: unknown
  'latestVersion'?: string | null
  'version'?: unknown
}

/** What {@link useGraphInspectorStore.probeEndpoint} found at an address. */
export type EndpointProbe
  = | { status: 'ready', endpointUrl: string, token: string }
    | { status: 'requires-token' }
    | { status: 'legacy' }
    | { status: 'unreachable' }

export const useGraphInspectorStore = defineStore('graph-inspector', () => {
  /**
   * The graph endpoint being viewed, never carrying an access token.
   *
   * This is the only record of which graph the viewer is on: the URL says which
   * *view* to show, not which graph. It is recovered from the printed link on
   * arrival and from the tab's session on a reload.
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
  /**
   * Endpoint the caller vouched for. Unlike an acknowledgement, this survives
   * pointing the store at a graph, because it is a statement about the endpoint
   * rather than about something the visitor was shown.
   */
  const trustedEndpointUrl = ref('')
  const dependencyTraceEnabled = ref(false)
  const showCircularDependencies = ref(true)
  const openModuleDetail = ref(false)
  let resolveVersionAcknowledgement: ((acknowledged: boolean) => void) | undefined

  const endpointUrl = computed(() => endpoint.value)

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
   * Whether a graph load is in flight.
   *
   * Owned here rather than by the page, because a load has more than one
   * starter — the page that lands, and the reload button in the viewer header —
   * and it spans three requests. A page-local flag saw only its own, which is
   * why the loading state used to be a guess between two half-signals.
   */
  const isLoading = ref(false)

  /**
   * Whether this tab holds a credential — not the credential itself, which
   * stays inside the store so it can only leave as a request header.
   */
  const hasAccessToken = computed(() => Boolean(accessToken.value))

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
      || endpointInfoError.value?.message
      || ''
  )
  /**
   * Whether the load failed, for any of the reasons it can fail for.
   *
   * The reasons differ in what the viewer should *say* — see
   * {@link endpointRequiresAccessToken} — but not in whether it should show an
   * error at all, and that is the question a page is asking.
   */
  const hasLoadError = computed(
    () =>
      endpointRequiresAccessToken.value
      || endpointUnreachable.value
      || status.value === 'error'
  )

  const graphIsStatic = computed(() => endpointInfo.value?.['is-static'] === true)

  /**
   * Whether the graph being viewed is this site's own demo, running in this tab.
   *
   * Its address is the only one the viewer invents for itself — the segment the
   * in-browser runtime's servers are reachable under — so it is worth naming as
   * a demo rather than showing an address that means nothing outside this tab.
   * Every other endpoint is somebody's application, where the address is the
   * most useful thing the header can say.
   */
  const isDemo = computed(() => Boolean(resolveInspectorMountBase(endpoint.value)))
  const directRunUrl = computed(() =>
    resolveDirectRunUrl(endpoint.value, graphIsStatic.value)
  )

  /**
   * Whether the endpoint failed to answer at all.
   *
   * Distinct from an endpoint that answered with something unexpected: a graph
   * that cannot be reached is almost always an application that is not running,
   * and saying "no data received" for it sends the developer looking in the
   * wrong place.
   */
  const endpointUnreachable = ref(false)

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
    endpointUnreachable.value = false
    resolveVersionAcknowledgement?.(false)
    resolveVersionAcknowledgement = undefined
  }

  function acknowledgeEndpointVersion() {
    acknowledgedVersionEndpointUrl.value = endpoint.value
    shouldShowVersionAcknowledgement.value = false
    resolveVersionAcknowledgement?.(true)
    resolveVersionAcknowledgement = undefined
  }

  /**
   * Marks an endpoint as already acknowledged.
   *
   * The in-browser demo is built from this repository together with the site
   * showing it, so asking the visitor to confirm that the two versions match
   * tells them nothing they can act on.
   */
  function trustEndpointVersion(url: string) {
    trustedEndpointUrl.value = url
  }

  async function ensureEndpointVersionAcknowledged() {
    if (
      !requiresVersionAcknowledgement(
        endpointInfo.value?.isLatestVersion,
        endpointInfo.value?.['is-static']
      )
      || acknowledgedVersionEndpointUrl.value === endpoint.value
      || trustedEndpointUrl.value === endpoint.value
    ) {
      return true
    }

    shouldShowVersionAcknowledgement.value = true
    return await new Promise<boolean>((resolve) => {
      resolveVersionAcknowledgement = resolve
    })
  }

  /**
   * Points the store at a graph endpoint, and remembers it for the tab.
   *
   * Nothing else records which graph is being viewed, so this is also what
   * makes a reload survivable.
   */
  function applyEndpoint(nextEndpointUrl: string, token?: string) {
    if (endpoint.value !== nextEndpointUrl) {
      endpoint.value = nextEndpointUrl
      accessToken.value = ''
      clearGraph()
    }

    if (token !== undefined) {
      accessToken.value = token
    }

    writeGraphSession({
      endpointUrl: nextEndpointUrl,
      token: accessToken.value
    })
  }

  /**
   * Forgets the endpoint held in memory, without forgetting the tab's session.
   *
   * Used while the in-browser demo is restarted: the endpoint the tab was on
   * died with the document that started it, and nothing may be fetched from it
   * in the meantime — least of all with the credential that went with it. The
   * session stays, so a failed restart can still say which graph it was.
   */
  function releaseEndpoint() {
    endpoint.value = ''
    accessToken.value = ''
    clearGraph()
  }

  /**
   * Records the graph a printed link handed over, without loading it.
   *
   * The router layer calls this: it has to take custody of the endpoint and
   * token before it redirects, but loading belongs to the page that lands.
   */
  function setSession(nextEndpointUrl: string, token: string) {
    applyEndpoint(nextEndpointUrl, token)
  }

  /**
   * Recovers the graph this tab was on, for a load that arrived without a
   * printed link — a reload, or a viewer page opened directly.
   *
   * Returns the endpoint it restored, or an empty string when the tab is not
   * on a graph at all and the caller should send the visitor back to `/view`.
   */
  function restoreSession(): string {
    if (endpoint.value) {
      return endpoint.value
    }

    const session = readGraphSession()
    if (!session) {
      return ''
    }

    applyEndpoint(session.endpointUrl, session.token)

    return session.endpointUrl
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

    // Keep the endpoint: the viewer still has to say which graph it could not
    // open. Only the credential is dropped.
    writeGraphSession({ endpointUrl: endpoint.value, token: '' })
  }

  async function validateEndpoint() {
    if (!informationUrl.value) {
      clearEndpointInfo()
      return false
    }

    // Every attempt starts without a verdict. `clearGraph()` only runs when the
    // endpoint changes, so a retry against the *same* endpoint would otherwise
    // inherit the last one — and report "access token required" for what is
    // really an application that has stopped answering.
    endpointRequiresAccessToken.value = false
    endpointUnreachable.value = false

    await executeEndpointInfo()

    const isValidEndpoint = endpointInfo.value?.for === 'nest-graph-inspector'
    if (isValidEndpoint) {
      shouldShowUpdateModal.value = false
      return true
    }

    if (readStatusCode(endpointInfoError.value) === 401) {
      discardRejectedAccessToken()
      return false
    }

    await executeLegacyGraph()
    shouldShowUpdateModal.value = isLegacyGraphOutput(legacyGraphData.value)

    // It never answered, and it is not an older graph served in its place. That
    // is a connection problem, not an empty graph.
    endpointUnreachable.value = Boolean(endpointInfoError.value)
      && !shouldShowUpdateModal.value

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

  /** Points the store at a graph and loads it. */
  async function setEndpoint(nextEndpointUrl: string, token?: string) {
    applyEndpoint(nextEndpointUrl, token)

    return await fetchGraph()
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

  /**
   * Asks whether an address is a graph inspector, without committing to it.
   *
   * `/view` probes a guessed origin on a timer. That must not touch the graph
   * this tab is already on: writing the probe into the store — or worse, into
   * the tab's session — would silently swap the endpoint out from under the
   * viewer and drop the token with it. So this reaches for the endpoint
   * directly and reports back, and only a caller that likes the answer calls
   * {@link setSession}.
   *
   * Deliberately not `inspectorFetch`: that attaches the token this tab already
   * holds to whatever it is given, which would hand a live credential to
   * whichever host is being probed.
   */
  async function probeEndpoint(input: string): Promise<EndpointProbe> {
    const { endpointUrl: sourceUrl, token } = splitSourceUrl(input)
    const infoUrl = appendOutputPath(sourceUrl, 'information.json')

    if (!infoUrl) {
      return { status: 'unreachable' }
    }

    const headers = accessTokenHeaders(token)

    try {
      const info = await $fetch<InspectorEndpointInfo>(infoUrl, { headers })

      if (info?.for === 'nest-graph-inspector') {
        shouldShowUpdateModal.value = false

        return { status: 'ready', endpointUrl: sourceUrl, token: token ?? '' }
      }
    } catch (error) {
      if (readStatusCode(error) === 401) {
        return { status: 'requires-token' }
      }

      return { status: 'unreachable' }
    }

    // It answered, but not with the inspector's own payload. An older version
    // served the graph itself at this path, which is worth telling the
    // developer about rather than reporting as unreachable.
    try {
      const legacy = await $fetch<LegacyGraphOutput>(sourceUrl, { headers })

      if (isLegacyGraphOutput(legacy)) {
        shouldShowUpdateModal.value = true

        return { status: 'legacy' }
      }
    } catch {
      // Not a graph either.
    }

    return { status: 'unreachable' }
  }

  /**
   * Loads everything the viewer shows for the current endpoint.
   *
   * The one place a graph load happens, so it is also the one place that knows
   * a load is in flight.
   */
  async function fetchGraph() {
    isLoading.value = true

    try {
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
    } finally {
      isLoading.value = false
    }
  }

  return {
    // `accessToken` itself is deliberately not exposed: callers get
    // `requestHeaders`, so there is no way to put the raw credential anywhere
    // other than a request header.
    requestHeaders,
    isLoading,
    hasLoadError,
    hasAccessToken,
    endpointUrl,
    informationUrl,
    jsonUrl,
    markdownUrl,
    ollamaUrl,
    directRunUrl,
    graphData,
    graphMarkdown,
    graphIsStatic,
    isDemo,
    endpointVersion,
    endpointRequiresAccessToken,
    endpointUnreachable,
    latestVersion,
    status,
    error,
    errorMessage,
    shouldShowUpdateModal,
    shouldShowVersionAcknowledgement,
    dependencyTraceEnabled,
    showCircularDependencies,
    openModuleDetail,
    setSession,
    releaseEndpoint,
    restoreSession,
    toggleDependencyTrace,
    validateEndpoint,
    acknowledgeEndpointVersion,
    trustEndpointVersion,
    setEndpoint,
    probeEndpoint,
    fetchJson,
    fetchMarkdown,
    fetchGraph
  }
})
