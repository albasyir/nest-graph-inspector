/**
 * Query parameter carrying the inspector access token.
 *
 * Must match `ACCESS_TOKEN_QUERY_PARAM` in the `nest-graph-inspector` library.
 */
export const INSPECTOR_ACCESS_TOKEN_PARAM = '__inspector_token'

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
 * Reads the access token out of a graph endpoint URL.
 *
 * The endpoint URL is the only thing the viewer is handed, so it is also where
 * the token travels.
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
 * Removes the access token from a URL before it leaves the browser.
 *
 * The token is a live credential for the inspected application, so anything
 * that ships a graph URL onward — analytics, error reports, logs — has to send
 * a redacted one.
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
    // textually rather than let a token through.
    return endpointUrl.replace(
      new RegExp(`([?&])${INSPECTOR_ACCESS_TOKEN_PARAM}=[^&#]*&?`, 'g'),
      '$1'
    )
  }
}

/**
 * Copies the access token from a graph endpoint URL onto a derived URL.
 *
 * Derived URLs (`/direct-run`, `/ollama`) are rebuilt from the endpoint origin
 * and would otherwise drop the token along with the rest of the query string.
 */
export function withAccessToken(url: URL, endpointUrl: string): URL {
  const token = readAccessToken(endpointUrl)

  if (token) {
    url.searchParams.set(INSPECTOR_ACCESS_TOKEN_PARAM, token)
  }

  return url
}
