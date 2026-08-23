import {
  createGraphViewerEventProperties,
  resolveGraphViewerLoadSource,
  type LoadSource
} from '~/utils/graph-viewer-analytics'
import { parseViewerUrlParam } from '~/utils/inspector-access-token'

/**
 * Loads the graph a `/view/:url` page is pointed at, and takes the access
 * token out of the address bar on the way.
 *
 * By the time a page gets here the access token is already out of the route and
 * in the store — `plugins/inspector-access-token.client.ts` and
 * `middleware/inspector-access-token.global.ts` between them see to that before
 * any page is created. What is left is an endpoint, which this loads and
 * reports on.
 */
export function useGraphViewerRoute() {
  const route = useRoute()
  const posthog = usePostHog()
  const graphStore = useGraphInspectorStore()

  /** Endpoint and credential carried by the current route segment. */
  const viewerParam = computed(() => parseViewerUrlParam(route.params.url))

  /** The segment as it should appear once the token is removed. */
  const encodedUrl = computed(() => viewerParam.value.encoded)

  /**
   * The endpoint this route points at, derived from the route rather than the
   * store — the store is empty until the browser starts loading, so a server
   * render that read it would disagree with the client's first paint.
   */
  const routeEndpointUrl = computed(() => viewerParam.value.endpointUrl)

  // Rendered on the server as the state the client starts in, so hydration
  // agrees with the load that is about to begin in the browser.
  const isGraphLoading = ref(Boolean(viewerParam.value.endpointUrl))
  let hasTrackedInitialMount = false

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
        // The parsed endpoint rather than the store's, so the very first event
        // of a load already names the right graph — and never a token.
        graphUrl: viewerParam.value.endpointUrl,
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

    const { endpointUrl: endpoint } = viewerParam.value

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

      if (!graphStore.endpointUrl) {
        await navigateTo('/view')
      }
    } finally {
      isGraphLoading.value = false
    }
  }

  watch(encodedUrl, () => {
    const loadSource = resolveGraphViewerLoadSource(hasTrackedInitialMount)
    hasTrackedInitialMount = true
    void loadGraphResources(loadSource)
  }, { immediate: true })

  function refresh() {
    void loadGraphResources('manual_refresh', true)
  }

  return {
    encodedUrl,
    routeEndpointUrl,
    isGraphLoading,
    refresh
  }
}
