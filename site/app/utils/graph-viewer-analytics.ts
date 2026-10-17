import { isViewerPage } from './viewer-bootstrap-link.ts'

export type LoadSource = 'initial_mount' | 'route_change' | 'manual_refresh'

export function resolveGraphViewerLoadSource(hasTrackedInitialMount: boolean): LoadSource {
  return hasTrackedInitialMount ? 'route_change' : 'initial_mount'
}

/**
 * Paths an event may name a graph endpoint by: the library's own defaults,
 * served from the root of an application's server or through the in-browser
 * demo's bridge. A path can be configured to anything, a secret included, so
 * every other one is left out.
 */
const REPORTABLE_GRAPH_PATH
  = /^(?:(?:\/nest-graph-inspector)?\/__nodepod__\/\d{1,5})?\/__(?:nest-)?graph-inspector\/?$/

/**
 * The parts of a graph endpoint an event may carry.
 *
 * Built from the parts known to be safe rather than by stripping the ones known
 * to be dangerous, which have more spellings than a strip can list: a token
 * under a percent-encoded name, user info, a fragment, a configured path. The
 * origin of an http(s) URL is the one part its parser guarantees holds none of
 * those; the path joins it only when it is one of the library's own. A URL that
 * does not parse, or is not http(s), is described by nothing at all.
 */
export function describeGraphEndpoint(graphUrl: string) {
  try {
    const url = new URL(graphUrl)

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const path = REPORTABLE_GRAPH_PATH.test(url.pathname) ? url.pathname : ''

      return {
        graph_url: `${url.origin}${path}`,
        graph_url_host: url.host,
        graph_url_path: path
      }
    }
  } catch {
    // Described by nothing, below.
  }

  return { graph_url: '', graph_url_host: '', graph_url_path: '' }
}

/**
 * A viewer route as an event may name it.
 *
 * The viewer's own pages name a view and nothing else, so they are reported as
 * they are: which view a load or a failure happened on is the whole point of the
 * property. Anything else is named by its shape, never its content — a printed
 * link (`/view/<base64url endpoint>`) is a token in disguise, a module's deep
 * dive names part of the application, and a segment that arrived encoded could
 * be anything. A query or a fragment is never part of the name.
 *
 * Events should never fire from a printed link, because the router redirects
 * before a page is created, but deciding here rather than at each call site
 * means a caller passing `route.fullPath` cannot reintroduce the leak.
 */
function describeViewerRoute(viewerRoute: string) {
  const path = (viewerRoute.split(/[?#]/)[0] ?? '').replace(/\/+$/, '')
  const [, root, page = '', ...rest] = path.split('/')
  const isOwnPage = root === 'view' && (!page || isViewerPage(page))

  if (isOwnPage && !rest.length) {
    return path
  }

  if (isOwnPage && page === 'navigator' && rest[0] === 'modules' && rest.length === 2) {
    return '/view/navigator/modules/[module]'
  }

  const [linkPage = ''] = rest

  return rest.length === 1 && isViewerPage(linkPage)
    ? `/view/[url]/${linkPage}`
    : '/view/[url]'
}

/**
 * A load that failed, as the store saw it: enough to say what kind of failure
 * it was without a word of what the failed request said.
 */
export type GraphLoadFailure = {
  /** HTTP status the load failed with, `0` when it got none. */
  status: number
  /** The endpoint's handshake got no answer at all. */
  unreachable: boolean
  /** The endpoint answered with a graph this viewer cannot read. */
  unsupported: boolean
}

export function createGraphViewerEventProperties(options: {
  graphUrl: string
  viewerRoute: string
  loadSource: LoadSource
  isRetry?: boolean
  failure?: GraphLoadFailure
}) {
  const properties = {
    ...describeGraphEndpoint(options.graphUrl),
    viewer_route: describeViewerRoute(options.viewerRoute),
    load_source: options.loadSource
  } as {
    graph_url: string
    graph_url_host: string
    graph_url_path: string
    viewer_route: string
    load_source: LoadSource
    is_retry?: boolean
    error_status?: number
    error_message?: string
  }

  if (typeof options.isRetry === 'boolean') {
    properties.is_retry = options.isRetry
  }

  const { failure } = options

  // A failure is reported by its status or its kind, never in its own words: a
  // transport error quotes the URL it failed on, and an inspector's message
  // says whatever the endpoint chose to. A status of `0` is reported only for a
  // handshake that got no answer — an endpoint that answered with something
  // the viewer cannot use did respond, so it gets a kind and no status.
  if (failure?.status) {
    properties.error_status = failure.status
    properties.error_message = `HTTP ${failure.status}`
  } else if (failure?.unreachable) {
    properties.error_status = 0
    properties.error_message = 'No HTTP response'
  } else if (failure) {
    properties.error_message = failure.unsupported
      ? 'Unsupported graph version'
      : 'Unknown error'
  }

  return properties
}
