import type { GraphLayout, GraphOutput } from 'nest-graph-inspector'
import { defineStore } from 'pinia'
import {
  GRAPH_LAYOUT_FILE_NAME,
  isGraphLayout,
  readStoredLayout,
  serializeGraphLayout,
  writeStoredLayout
} from '~/utils/graph-layout-persistence'
import { requiresVersionAcknowledgement } from '~/utils/graph-inspector-version-gate'
import {
  countGraphModules,
  readBrightLineChoice,
  resolveShowBrightLine,
  writeBrightLineChoice
} from '~/utils/graph-viewer-bright-line'
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
import { describeFailedRequest, readStatusCode } from '~/utils/http-error'
import { readGraphFileText } from '~/utils/graph-file'
import {
  clearGraphFileSession,
  describeGraphFileDirectRun,
  graphFileKey,
  readGraphFileSession,
  writeGraphFileSession,
  type GraphFileSource
} from '~/utils/graph-file-session'
import {
  appendOutputPath,
  normalizeSourceUrl,
  resolveDirectRunUrl
} from '~/utils/inspector-endpoint-url'
import {
  clearGraphSession,
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

/** What {@link useGraphInspectorStore.restoreGraphSource} brought back for a tab. */
export type RestoredGraphSource = 'endpoint' | 'file' | 'none'

export const useGraphInspectorStore = defineStore('graph-inspector', () => {
  /**
   * The graph endpoint being viewed, never carrying an access token.
   *
   * With {@link fileSource}, this is the only record of which graph the viewer
   * is on: the URL says which *view* to show, not which graph. It is recovered
   * from the printed link on arrival and from the tab's session on a reload.
   */
  const endpoint = ref('')

  /**
   * The graph file being viewed, when the graph was read from a file rather
   * than fetched from an endpoint: one the visitor opened, or the demo
   * application's static graph. A file and an endpoint never coexist — opening
   * either forgets the other — and nothing is ever fetched for a file.
   */
  const fileSource = ref<GraphFileSource | null>(null)
  /** The graph read from {@link fileSource}, already checked by `graph-file.ts`. */
  const fileGraph = shallowRef<GraphOutput | null>(null)
  /**
   * A graph file the tab was on whose graph was too large to keep for a
   * reload: its name alone, so `/view` can ask for the file again.
   */
  const expiredGraphFile = ref<GraphFileSource | null>(null)
  /**
   * Changes whenever the viewer is put on another graph — another endpoint,
   * another file, or the same file opened again — so a view can start over
   * rather than carry one graph's unsaved state onto the next.
   */
  const graphRevision = ref(0)

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
  /**
   * The visitor's own Bright Line choice for the graph being viewed, or `null`
   * while they have made none and the graph's size decides. A choice belongs
   * to one graph, so it is read again whenever the endpoint changes.
   */
  const brightLineChoice = ref<boolean | null>(null)
  let resolveVersionAcknowledgement: ((acknowledged: boolean) => void) | undefined

  const endpointUrl = computed(() => endpoint.value)
  const isFileSource = computed(() => Boolean(fileSource.value))

  /**
   * What the graph's layout is kept under: its endpoint, or for a file, its
   * kind and name. Empty while the viewer is on no graph.
   */
  const graphKey = computed(() =>
    fileSource.value ? graphFileKey(fileSource.value) : endpoint.value
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
  const layoutUrl = computed(() =>
    appendOutputPath(endpoint.value, 'layout.json')
  )
  const layoutSaveUrl = computed(() =>
    appendOutputPath(endpoint.value, 'layout')
  )

  /** The layout the viewer is drawing, as last loaded or saved. */
  const layoutData = ref<GraphLayout | null>(null)
  /** Whether the canvas holds an arrangement that has not been saved. */
  const isLayoutDirty = ref(false)
  const isLayoutSaving = ref(false)
  const layoutSaveError = ref('')
  /** Why the saved layout could not be loaded; the viewer lays out itself. */
  const layoutLoadError = ref('')
  /** ISO 8601 time of the last successful save. */
  const layoutSavedAt = ref<string | null>(null)
  /**
   * Set when a live endpoint has no layout route — a library from before
   * layouts existed. Its layout is kept by the tab instead.
   */
  const layoutEndpointMissing = ref(false)
  let layoutSaveSequence = 0
  let layoutSaveChain: Promise<unknown> = Promise.resolve()

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
    data: fetchedGraphData,
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

  /**
   * HTTP status the load failed with, `0` when it got none — the one detail of
   * a failure the viewer shows or reports. What a failed request *said* never
   * is: a transport message quotes the URL, and a response body can quote
   * anything.
   *
   * Set by the request that just failed, never read back from the fetches: a
   * retry that stops at the handshake leaves the graph request's error from the
   * attempt before, and would report that.
   */
  const errorStatus = ref(0)
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

  /** The graph the viewer draws: the file's, or the one fetched from the endpoint. */
  const graphData = computed(() => fileGraph.value ?? fetchedGraphData.value)

  /**
   * Whether the graph was read from files rather than served by a running
   * process — a library writing static output, or a graph file opened here —
   * so nothing can be run against it.
   */
  const graphIsStatic = computed(() =>
    isFileSource.value || endpointInfo.value?.['is-static'] === true
  )

  /**
   * Whether the navigator's Bright Line is on: the visitor's choice for this
   * graph, else on for a small graph and off for a large one.
   *
   * Setting it is the visitor choosing, so it is kept for this graph for the
   * life of the tab: a refresh remounts the viewer and a reload starts the page
   * over, and neither may undo it.
   */
  const showBrightLine = computed({
    get: () =>
      resolveShowBrightLine({
        moduleCount: countGraphModules(graphData.value),
        choice: brightLineChoice.value
      }),
    set: (isOn: boolean) => {
      brightLineChoice.value = isOn
      writeBrightLineChoice(endpoint.value, isOn)
    }
  })

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
   * Why Direct Run is off for a graph file, which has neither an application
   * to call nor a trace history to point at instead. Unset for an endpoint.
   */
  const directRunDisabledReason = computed(() =>
    fileSource.value ? describeGraphFileDirectRun(fileSource.value) : undefined
  )

  /**
   * Where a layout is saved to. A live application writes it to its own file;
   * a static graph — a graph file included — has no server, the demo's file
   * system dies with the tab, and an older library has no layout route — those
   * keep it in the tab, from where the visitor can download it.
   */
  const layoutPersistence = computed<'endpoint' | 'session'>(() =>
    graphIsStatic.value || isDemo.value || layoutEndpointMissing.value
      ? 'session'
      : 'endpoint'
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
    errorStatus.value = 0
    resolveVersionAcknowledgement?.(false)
    resolveVersionAcknowledgement = undefined
    clearLayout()
  }

  function clearLayout() {
    // A save still in flight belongs to the previous graph; bumping the
    // sequence makes it drop its result instead of reporting it here.
    layoutSaveSequence += 1
    layoutData.value = null
    isLayoutDirty.value = false
    isLayoutSaving.value = false
    layoutSaveError.value = ''
    layoutLoadError.value = ''
    layoutSavedAt.value = null
    layoutEndpointMissing.value = false
  }

  /**
   * Records that the visitor accepted the version mismatch for this endpoint,
   * releasing whoever is waiting on {@link ensureEndpointVersionAcknowledged}.
   */
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

  /**
   * Resolves once the endpoint's version is settled, showing the prompt only
   * when there is something to settle.
   *
   * An endpoint already acknowledged in this tab, or trusted outright, passes
   * without asking. Otherwise this waits on the visitor's answer and resolves
   * to it — `false` when they backed out.
   */
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
    // An endpoint replaces a graph file, in memory and in the tab's session —
    // which the printed-link plugin may have written past without one.
    forgetGraphFile()
    expiredGraphFile.value = null

    if (endpoint.value !== nextEndpointUrl) {
      graphRevision.value += 1
      endpoint.value = nextEndpointUrl
      accessToken.value = ''
      // Another graph starts from its own default, or from what the visitor
      // chose for it earlier in this tab — never from the last graph's choice.
      brightLineChoice.value = readBrightLineChoice(nextEndpointUrl)
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
   * Forgets the endpoint, in memory and in the tab's session.
   *
   * For an in-browser demo endpoint nothing in this document answers any more:
   * the pod died with the document that started it, or is being stopped or
   * waited on. Nothing may be fetched from it in the meantime — least of all
   * with the credential that went with it — and a reload must not restore it,
   * since only a demo the visitor starts again mints a session worth keeping.
   */
  function releaseEndpoint() {
    endpoint.value = ''
    accessToken.value = ''
    clearGraph()
    clearGraphSession()
  }

  /** Drops the graph file, if the tab is on one, and its session. */
  function forgetGraphFile() {
    if (fileSource.value) {
      graphRevision.value += 1
      fileSource.value = null
      fileGraph.value = null
      clearGraph()
      brightLineChoice.value = null
    }

    clearGraphFileSession()
  }

  /**
   * Opens a graph read from a file — the visitor's own, or the demo's static
   * graph — in place of whatever the viewer was on.
   *
   * Nothing is fetched for it, ever: the endpoint is forgotten with its
   * credential and its session, so no request can go anywhere on the file's
   * behalf. The graph is kept for the tab, so a reload shows it again when it
   * fits in the tab's storage; returns whether it did.
   */
  function openGraphFile(graph: GraphOutput, source: GraphFileSource): boolean {
    if (endpoint.value) {
      endpoint.value = ''
      accessToken.value = ''
      clearGraphSession()
    }

    clearGraph()
    graphRevision.value += 1
    expiredGraphFile.value = null
    fileSource.value = source
    fileGraph.value = graph
    // A Bright Line choice is kept for the tab by endpoint; a file's lives in
    // memory, for as long as the file is open.
    brightLineChoice.value = null
    layoutData.value = readStoredLayout(graphFileKey(source))

    return writeGraphFileSession(source, graph)
  }

  /** Closes the graph file: the viewer is on no graph until another opens. */
  function closeGraphFile() {
    forgetGraphFile()
    expiredGraphFile.value = null
  }

  /**
   * Brings back the graph file this tab was on, for a reload. A file whose
   * graph did not fit in the tab's storage comes back as
   * {@link expiredGraphFile} instead, for `/view` to ask for it again.
   */
  function restoreGraphFile(): boolean {
    const session = readGraphFileSession()
    if (!session) {
      return false
    }

    if (session.graphText === undefined) {
      expiredGraphFile.value = session.source
      clearGraphFileSession()
      return false
    }

    // Checked again, as on the way in: session storage is the visitor's to edit.
    const result = readGraphFileText(session.graphText, session.source.name)
    if (!result.ok) {
      clearGraphFileSession()
      return false
    }

    clearGraph()
    fileSource.value = session.source
    fileGraph.value = result.graph
    brightLineChoice.value = null
    layoutData.value = readStoredLayout(graphFileKey(session.source))

    return true
  }

  /**
   * Recovers whatever graph this tab was on, for a load that arrived without a
   * printed link — a reload, or a viewer page opened directly: an endpoint, as
   * {@link restoreSession} does, or a graph file.
   */
  function restoreGraphSource(): RestoredGraphSource {
    if (fileSource.value) {
      return 'file'
    }

    if (restoreSession()) {
      return 'endpoint'
    }

    return restoreGraphFile() ? 'file' : 'none'
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
    // inherit the last one — and report "access token required", or the status
    // of a request this attempt never made, for what is really an application
    // that has stopped answering.
    endpointRequiresAccessToken.value = false
    endpointUnreachable.value = false
    errorStatus.value = 0

    await executeEndpointInfo()

    const isValidEndpoint = endpointInfo.value?.for === 'nest-graph-inspector'
    if (isValidEndpoint) {
      shouldShowUpdateModal.value = false
      return true
    }

    errorStatus.value = readStatusCode(endpointInfoError.value)

    if (errorStatus.value === 401) {
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

    // This request's own answer: its status when it failed, `0` once it has
    // succeeded — never one left behind by an earlier attempt.
    errorStatus.value = status.value === 'success' ? 0 : readStatusCode(error.value)

    if (status.value !== 'success') {
      shouldShowUpdateModal.value = false

      if (errorStatus.value === 401) {
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

  /**
   * Loads the saved layout for the current endpoint.
   *
   * Never fails the graph load: without a layout the viewer lays the graph out
   * itself, so every failure here leaves `layoutData` empty and, when it is
   * worth telling the visitor, says why in `layoutLoadError`.
   */
  async function fetchLayout(): Promise<GraphLayout | null> {
    const requestedKey = graphKey.value
    const requestedEndpoint = endpoint.value
    layoutLoadError.value = ''
    isLayoutDirty.value = false

    if (!requestedKey) {
      layoutData.value = null
      return null
    }

    if (layoutPersistence.value === 'session') {
      layoutData.value = readStoredLayout(requestedKey)
      return layoutData.value
    }

    try {
      const layout = await inspectorFetch<unknown>(layoutUrl.value)
      if (endpoint.value !== requestedEndpoint) {
        return null
      }

      if (!isGraphLayout(layout)) {
        layoutData.value = null
        layoutLoadError.value
          = 'The inspector answered with something that is not a graph layout.'
        return null
      }

      layoutData.value = layout
    } catch (error) {
      if (endpoint.value !== requestedEndpoint) {
        return null
      }

      const statusCode = readStatusCode(error)
      if (statusCode === 404) {
        // A library from before layouts existed. Not an error worth showing:
        // the tab keeps the layout instead.
        layoutEndpointMissing.value = true
        layoutData.value = readStoredLayout(requestedEndpoint)
        return layoutData.value
      }

      if (statusCode === 401) {
        discardRejectedAccessToken()
      }

      layoutData.value = null
      layoutLoadError.value = describeFailedRequest('The layout could not be loaded', statusCode)
    }

    return layoutData.value
  }

  /**
   * Saves a layout where this endpoint keeps them, and makes it the one the
   * viewer draws.
   *
   * Saves run one at a time, in order, and a save superseded by a newer one
   * before it started is skipped — each carries the whole layout, so only the
   * newest needs to land. Resolves to whether this call's layout, or the newer
   * one that replaced it, was saved; a failure is also left in
   * `layoutSaveError`.
   */
  async function saveLayout(layout: GraphLayout): Promise<boolean> {
    layoutData.value = layout
    isLayoutDirty.value = true
    const sequence = ++layoutSaveSequence
    const requestedKey = graphKey.value

    const saving = layoutSaveChain.then(async () => {
      if (sequence !== layoutSaveSequence) {
        return true
      }

      return await persistLayout(layout, sequence, requestedKey)
    })
    layoutSaveChain = saving.catch(() => undefined)

    return await saving
  }

  async function persistLayout(
    layout: GraphLayout,
    sequence: number,
    requestedKey: string
  ): Promise<boolean> {
    const isCurrent = () =>
      sequence === layoutSaveSequence && graphKey.value === requestedKey

    if (!requestedKey) {
      return false
    }

    isLayoutSaving.value = true
    layoutSaveError.value = ''

    try {
      if (layoutPersistence.value === 'session') {
        writeStoredLayout(requestedKey, layout)
      } else {
        await inspectorFetch(layoutSaveUrl.value, {
          method: 'POST',
          body: layout
        })
      }

      if (isCurrent()) {
        isLayoutDirty.value = false
        layoutSavedAt.value = new Date().toISOString()
      }

      return true
    } catch (error) {
      if (readStatusCode(error) === 401) {
        discardRejectedAccessToken()
      }

      if (isCurrent()) {
        layoutSaveError.value = describeFailedRequest(
          'The layout could not be saved',
          readStatusCode(error)
        )
      }

      return false
    } finally {
      if (isCurrent()) {
        isLayoutSaving.value = false
      }
    }
  }

  /**
   * Downloads a layout as the file the library would have written, for a
   * graph whose layout cannot be saved to the application — commit it beside
   * the application and it is picked up from there.
   */
  function downloadLayout(layout: GraphLayout) {
    if (!import.meta.client) {
      return
    }

    const url = URL.createObjectURL(
      new Blob([serializeGraphLayout(layout)], { type: 'application/json' })
    )
    const link = document.createElement('a')
    link.href = url
    link.download = GRAPH_LAYOUT_FILE_NAME
    link.click()
    URL.revokeObjectURL(url)
  }

  /**
   * Notes that the canvas has moved away from the saved layout, without
   * saving it yet.
   */
  function markLayoutDirty() {
    isLayoutDirty.value = true
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
      endpointUrl: token === undefined ? sourceUrl : redactAccessToken(sourceUrl),
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
    // A graph file was read whole when it was opened; there is nothing to fetch.
    if (fileSource.value) {
      return Boolean(fileGraph.value)
    }

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
        await Promise.all([fetchMarkdown(), fetchLayout()])
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
    fileSource,
    isFileSource,
    expiredGraphFile,
    graphRevision,
    informationUrl,
    jsonUrl,
    markdownUrl,
    directRunUrl,
    directRunDisabledReason,
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
    errorStatus,
    shouldShowUpdateModal,
    shouldShowVersionAcknowledgement,
    dependencyTraceEnabled,
    showCircularDependencies,
    showBrightLine,
    openModuleDetail,
    setSession,
    releaseEndpoint,
    restoreSession,
    restoreGraphSource,
    openGraphFile,
    closeGraphFile,
    toggleDependencyTrace,
    validateEndpoint,
    acknowledgeEndpointVersion,
    trustEndpointVersion,
    setEndpoint,
    probeEndpoint,
    fetchJson,
    fetchMarkdown,
    fetchGraph,
    layoutUrl,
    layoutSaveUrl,
    layoutData,
    layoutPersistence,
    isLayoutDirty,
    isLayoutSaving,
    layoutSaveError,
    layoutLoadError,
    layoutSavedAt,
    fetchLayout,
    saveLayout,
    downloadLayout,
    markLayoutDirty
  }
})
