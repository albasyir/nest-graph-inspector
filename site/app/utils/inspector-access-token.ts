/**
 * Query parameter carrying the inspector access token.
 *
 * Must match `ACCESS_TOKEN_QUERY_PARAM` in the `nest-graph-inspector` library.
 * The viewer only ever *reads* this parameter, out of the bootstrap link the
 * library prints. It never puts a token back into a URL.
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
 * Decodes the graph endpoint URL carried in the `/view/:url` route segment.
 *
 * The library encodes it with Node's `base64url` alphabet, which swaps `+`
 * and `/` for `-` and `_`. `atob` only accepts standard base64, so the
 * alphabet is translated back and the stripped padding restored first.
 */
export function decodeEndpointUrl(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const paddingLength = (4 - (base64.length % 4)) % 4

  return atob(base64.padEnd(base64.length + paddingLength, '='))
}

/**
 * Encodes a graph endpoint URL for the `/view/:url` route segment.
 *
 * Emits the same `base64url` form the library prints, so a link the viewer
 * builds is indistinguishable from one it was handed, and needs no further
 * percent-encoding to survive a path segment.
 */
export function encodeEndpointUrl(endpointUrl: string): string {
  return btoa(endpointUrl)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

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

/** Endpoint and credential recovered from a `/view/:url` route segment. */
export type ViewerUrlParam = {
  /** The route segment as it should appear once the token is removed. */
  encoded: string
  /** Graph endpoint URL, never carrying a token. */
  endpointUrl: string
  /** Token the segment carried, empty when it carried none. */
  token: string
}

/**
 * Splits a `/view/:url` route segment into the endpoint to load and the
 * credential to hold on to.
 *
 * The segment is a bootstrap link: it is the one channel that hands the viewer
 * a token, and the last place that token is allowed to appear. Callers load
 * `endpointUrl`, keep `token` in the store, and rewrite the address bar to
 * `encoded`.
 */
export function parseViewerUrlParam(
  param: string | string[] | undefined
): ViewerUrlParam {
  const raw = Array.isArray(param) ? param[0] : param
  const empty: ViewerUrlParam = { encoded: '', endpointUrl: '', token: '' }

  if (!raw) {
    return empty
  }

  let decoded: string
  try {
    decoded = decodeEndpointUrl(decodeURIComponent(raw))
  } catch {
    return empty
  }

  const token = readAccessToken(decoded)
  const endpointUrl = token ? redactAccessToken(decoded) : decoded

  // `encoded` is always the canonical base64url form, even when there was no
  // token to strip. An older build of this site minted padded standard base64,
  // which decodes to the same endpoint but is a different string — and letting
  // both forms circulate means the route and the links the store builds from
  // the same endpoint disagree.
  return { encoded: encodeEndpointUrl(endpointUrl), endpointUrl, token: token ?? '' }
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
