import {
  createGraphViewerEventProperties,
  resolveGraphViewerLoadSource,
  type LoadSource
} from '~/utils/graph-viewer-analytics'

/**
 * Loads the graph a viewer page is showing.
 *
 * The page's URL says which view to render, not which graph — the graph itself
 * comes from the store, put there by the printed link this tab was opened with
 * and kept across reloads in the tab's session.
 * `middleware/graph-viewer-bootstrap.global.ts` guarantees both are in place
 * before a page is created, so by the time this runs there is an endpoint to
 * load or nothing to show at all.
 */
/**
 * Whether this tab has already loaded a viewer page.
 *
 * Module scope, not component scope: each viewer page is its own component, so
 * a per-component flag would report every tab switch as a first arrival. A full
 * reload resets the module, which is exactly when `initial_mount` is true again.
 */
let hasLoadedOnce = false

export function useGraphViewerPage() {
  const route = useRoute()
  const posthog = usePostHog()
  const graphStore = useGraphInspectorStore()
  const { startupMessage, ensureEndpoint } = useNodepodDemoSession()

  /** The endpoint being shown, for the loading state and the header. */
  const endpointUrl = computed(() => graphStore.endpointUrl)

  /** The store owns this: a load can also be started from the viewer header. */
  const isGraphLoading = computed(() => graphStore.isLoading)

  function trackGraphViewerEvent(
    event: string,
    options: {
      loadSource: LoadSource
      isRetry?: boolean
      errorMessage?: string
    }
  ) {
    posthog?.capture(
      event,
      createGraphViewerEventProperties({
        graphUrl: graphStore.endpointUrl,
        viewerRoute: route.path,
        loadSource: options.loadSource,
        isRetry: options.isRetry,
        errorMessage: options.errorMessage
      })
    )
  }

  async function loadGraphResources(loadSource: LoadSource, isRetry = false) {
    // Every request goes to the inspected application on the developer's own
    // machine, which only the browser can reach.
    if (import.meta.server) {
      return
    }

    const restored = graphStore.restoreSession()

    if (!restored) {
      await navigateTo('/view')
      return
    }

    // The in-browser demo lives in the tab that started it, so a session
    // restored without one has to start it again — and lands on a new endpoint.
    const endpoint = await ensureEndpoint(restored)

    if (!endpoint) {
      await navigateTo('/view')
      return
    }

    trackGraphViewerEvent('graph_viewer_load_started', {
      loadSource,
      isRetry
    })

    if (await graphStore.setEndpoint(endpoint)) {
      trackGraphViewerEvent('graph_viewer_load_succeeded', {
        loadSource,
        isRetry
      })
      return
    }

    trackGraphViewerEvent('graph_viewer_load_failed', {
      loadSource,
      isRetry,
      errorMessage: graphStore.errorMessage || 'Unknown error'
    })
  }

  // One load per page, at setup. Moving between viewer pages mounts a new page
  // component, so this is where a tab switch is told apart from a first arrival.
  void loadGraphResources(resolveGraphViewerLoadSource(hasLoadedOnce))
  hasLoadedOnce = true

  function refresh() {
    void loadGraphResources('manual_refresh', true)
  }

  return {
    endpointUrl,
    isGraphLoading,
    /** What the viewer is waiting on, when it is waiting on the demo. */
    startupMessage,
    refresh
  }
}
