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
 * Removes the access token from a URL.
 *
 * The token is a live credential for the inspected application, so it is
 * stripped the moment the bootstrap link is read, and stripped again from
 * anything that ships a graph URL onward — analytics, error reports, logs.
 */
export function redactAccessToken(endpointUrl: string): string {
  if (!endpointUrl || !endpointUrl.includes(INSPECTOR_ACCESS_TOKEN_PARAM)) {
    return endpointUrl
  }

  try {
    const url = new URL(endpointUrl)
    url.searchParams.delete(INSPECTOR_ACCESS_TOKEN_PARAM)

    return url.toString()
  } catch {
    // Not parseable as a URL, but it still mentions the parameter, so strip it
    // textually rather than let a token through. The value ends at a query
    // separator or at whitespace or a quote, because the input here is as
    // likely to be a URL quoted inside an error message as a URL on its own —
    // and cutting to the end of the line would take the message with it.
    return endpointUrl.replace(
      new RegExp(`([?&]?)${INSPECTOR_ACCESS_TOKEN_PARAM}=[^&#\\s"']*&?`, 'g'),
      '$1'
    )
  }
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
 * Only one may: a graph served from the viewer's own origin. That is the demo
 * fixture shipped with this site — static files, nothing gated, no application
 * behind it.
 *
 * Every other endpoint is somebody's running application. The printed link is
 * the only thing that hands over a token for it, so arriving at a viewer page
 * without one means the link was not the way in, and the viewer has nothing to
 * authenticate with.
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
