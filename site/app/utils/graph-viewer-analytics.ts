import { redactAccessToken } from './inspector-access-token.ts'

export type LoadSource = 'initial_mount' | 'route_change' | 'manual_refresh'

export function resolveGraphViewerLoadSource(hasTrackedInitialMount: boolean): LoadSource {
  return hasTrackedInitialMount ? 'route_change' : 'initial_mount'
}

function parseGraphUrl(graphUrl: string) {
  if (!graphUrl) {
    return {
      graph_url: '',
      graph_url_host: '',
      graph_url_path: ''
    }
  }

  // The graph URL carries the inspector access token, which must never reach
  // an analytics sink.
  const safeGraphUrl = redactAccessToken(graphUrl)

  try {
    const url = new URL(safeGraphUrl)

    return {
      graph_url: safeGraphUrl,
      graph_url_host: url.host,
      graph_url_path: url.pathname
    }
  } catch {
    return {
      graph_url: safeGraphUrl,
      graph_url_host: '',
      graph_url_path: ''
    }
  }
}

/**
 * Replaces the encoded endpoint in a viewer route with the route template.
 *
 * `/view/:url` carries the base64url graph endpoint, and that endpoint carries
 * the access token — so the raw route path is a token in disguise. Redacting
 * here rather than at each call site means a caller passing `route.fullPath`
 * cannot reintroduce the leak, and the page itself is still identifiable.
 */
function redactViewerRoute(viewerRoute: string) {
  return viewerRoute.replace(/^(\/view)\/[^/]+/, '$1/[url]')
}

export function createGraphViewerEventProperties(options: {
  graphUrl: string
  viewerRoute: string
  loadSource: LoadSource
  isRetry?: boolean
  errorMessage?: string
}) {
  const properties = {
    ...parseGraphUrl(options.graphUrl),
    viewer_route: redactViewerRoute(options.viewerRoute),
    load_source: options.loadSource
  } as {
    graph_url: string
    graph_url_host: string
    graph_url_path: string
    viewer_route: string
    load_source: LoadSource
    is_retry?: boolean
    error_message?: string
  }

  if (typeof options.isRetry === 'boolean') {
    properties.is_retry = options.isRetry
  }

  if (options.errorMessage) {
    // Transport errors quote the request URL they failed on, so this string is
    // a URL in disguise and gets the same treatment as one.
    properties.error_message = redactAccessToken(options.errorMessage)
  }

  return properties
}
