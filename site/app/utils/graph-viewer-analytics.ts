import { redactAccessToken } from './inspector-access-token.ts'
import { isViewerPage } from './viewer-bootstrap-link.ts'

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
 * Replaces an encoded endpoint in a viewer route with the route template.
 *
 * The viewer's own pages — `/view/navigator` and friends — name a view and
 * nothing else, so they are reported as they are: which view a load or a failure
 * happened on is the whole point of the property.
 *
 * A printed link (`/view/<base64url endpoint>`) is the one route shape that is a
 * token in disguise. Events should never fire from one, because the router
 * redirects before a page is created, but redacting here rather than at each
 * call site means a caller passing `route.fullPath` cannot reintroduce the leak.
 */
function redactViewerRoute(viewerRoute: string) {
  const [, view, segment] = viewerRoute.split('/')

  if (view !== 'view' || !segment || isViewerPage(segment)) {
    return viewerRoute
  }

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
