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
export function useGraphViewerPage() {
  const route = useRoute()
  const posthog = usePostHog()
  const graphStore = useGraphInspectorStore()

  /** The endpoint being shown, for the loading state and the header. */
  const endpointUrl = computed(() => graphStore.endpointUrl)

  // The server has no session to read, so it renders the state the browser
  // starts in: about to load.
  const isGraphLoading = ref(true)

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

    const endpoint = graphStore.restoreSession()

    if (!endpoint) {
      await navigateTo('/view')
      return
    }

    isGraphLoading.value = true

    try {
      trackGraphViewerEvent('graph_viewer_load_started', {
        loadSource,
        isRetry
      })

      const graphLoaded = await graphStore.setEndpoint(endpoint)
      if (graphLoaded) {
        await graphStore.fetchMarkdown()
        trackGraphViewerEvent('graph_viewer_load_succeeded', {
          loadSource,
          isRetry
        })
      } else {
        trackGraphViewerEvent('graph_viewer_load_failed', {
          loadSource,
          isRetry,
          errorMessage: graphStore.errorMessage || 'Unknown error'
        })
      }
    } finally {
      isGraphLoading.value = false
    }
  }

  // One load per page, at setup. Moving between viewer pages mounts a new page
  // component, so each arrival is its own initial mount.
  void loadGraphResources(resolveGraphViewerLoadSource(false))

  function refresh() {
    void loadGraphResources('manual_refresh', true)
  }

  return {
    endpointUrl,
    isGraphLoading,
    refresh
  }
}
