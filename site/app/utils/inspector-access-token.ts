/**
 * Query parameter carrying the inspector access token.
 *
 * Must match `ACCESS_TOKEN_QUERY_PARAM` in the `nest-graph-inspector` library.
 * The viewer only ever *reads* this parameter, out of the printed link it is
 * handed. It never puts a token back into a URL.
 */
export const INSPECTOR_ACCESS_TOKEN_PARAM = '__inspector_token'

/**
 * Request header carrying the inspector access token.
 *
 * Must match `ACCESS_TOKEN_HEADER` in the `nest-graph-inspector` library. Every
 * request the viewer makes to the inspected application authenticates through
 * this header, so no URL the viewer builds — or requests — carries a token.
 */
export const INSPECTOR_ACCESS_TOKEN_HEADER = 'x-graph-inspector-token'

/**
 * Reads the access token out of a graph endpoint URL.
 *
 * Only the bootstrap link carries one: the library embeds the token in the
 * endpoint URL it encodes into the printed viewer link.
 */
export function readAccessToken(endpointUrl: string): string | undefined {
  if (!endpointUrl) {
    return undefined
  }

  try {
    const token = new URL(endpointUrl).searchParams.get(
      INSPECTOR_ACCESS_TOKEN_PARAM
    )

    return token ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Removes the access token from a URL, leaving the URL usable.
 *
 * The token is a live credential for the inspected application, so it is
 * stripped the moment the bootstrap link is read. A query pair is the token's
 * when its name *decodes* to the parameter — that is how `readAccessToken` and
 * the library both read it, so `%5F%5Finspector_token` is the token too. Every
 * such pair goes; every other pair, the user info and the fragment stay exactly
 * as they were, and a URL with no token pair comes back unchanged.
 *
 * A URL that does not parse cannot be searched reliably, so none of it comes
 * back. This keeps a URL working; it does not make one safe to report —
 * analytics describes an endpoint with `describeGraphEndpoint` instead.
 */
export function redactAccessToken(endpointUrl: string): string {
  let url: URL

  try {
    url = new URL(endpointUrl)
  } catch {
    return ''
  }

  // `URLSearchParams` and the `search` setter each drop one leading `?`, and a
  // name may begin with one of its own — `?__inspector_token` is not the token,
  // and `?mode` is not `mode` — so each is handed a `?` of ours to drop instead.
  const pairs = url.search.slice(1).split('&')
  const kept = pairs.filter(
    pair => !new URLSearchParams(`?${pair}`).has(INSPECTOR_ACCESS_TOKEN_PARAM)
  )

  if (kept.length === pairs.length) {
    return endpointUrl
  }

  const query = kept.join('&')

  url.search = query ? `?${query}` : ''

  return url.toString()
}

/**
 * Headers that authenticate a request to the inspected application.
 *
 * Empty when there is no token — either token protection is off, or the graph
 * is a static fixture served from the viewer's own origin.
 */
export function accessTokenHeaders(
  token: string | undefined
): Record<string, string> {
  return token ? { [INSPECTOR_ACCESS_TOKEN_HEADER]: token } : {}
}

/**
 * Whether a graph may be opened with no access token at all.
 *
 * Only one may: a graph served from the viewer's own origin. That is this
 * site's own demo, which runs in the visitor's browser and is reachable from
 * nowhere else — its own endpoint still refuses a request without the token it
 * printed, so nothing here is what protects it.
 *
 * Every other endpoint is somebody's running application, reached over the
 * network. The printed link is the only thing that hands over a token for it,
 * so arriving at a viewer page without one means the link was not the way in,
 * and the viewer has nothing to authenticate with.
 */
export function canOpenWithoutAccessToken(
  endpointUrl: string,
  viewerOrigin: string
): boolean {
  if (!endpointUrl || !viewerOrigin) {
    return false
  }

  try {
    return new URL(endpointUrl).origin === viewerOrigin
  } catch {
    return false
  }
}
