import { readAccessToken, redactAccessToken } from './inspector-access-token.ts'

/**
 * The viewer's own pages, which carry no graph identity in their URL.
 *
 * The graph being viewed lives in the store for the tab, not in the path — so
 * these paths mean "show me this view of whatever graph this tab is on".
 */
export const VIEWER_PAGES = ['navigator', 'issues', 'execution-sequence'] as const

export type ViewerPage = (typeof VIEWER_PAGES)[number]

/** Where a graph, and the credential for it, came from. */
export type ViewerBootstrap = {
  /** The viewer page to land on. */
  path: string
  /** Graph endpoint URL, never carrying a token. */
  endpointUrl: string
  /** Token the link carried, empty when it carried none. */
  token: string
}

/**
 * Decodes the graph endpoint URL out of a printed viewer link.
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

/** Whether a path segment names one of the viewer's own pages. */
export function isViewerPage(segment: string): segment is ViewerPage {
  return (VIEWER_PAGES as readonly string[]).includes(segment)
}

/**
 * Reads a printed viewer link and says where it should land.
 *
 * `/view/<base64url(endpoint)>` is the one thing the library hands a developer,
 * and the only channel that carries a graph endpoint or an access token into
 * the viewer. It is spent on arrival: the endpoint and token go to the store,
 * and the address bar is replaced with a plain `/view/<page>`.
 *
 * Returns nothing when the path is not a link to spend — one of the viewer's
 * own pages, or a segment that is not a graph endpoint at all.
 */
export function resolveViewerBootstrap(
  path: string
): ViewerBootstrap | undefined {
  const match = /^\/view\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path)
  const segment = match?.[1]

  if (!segment || isViewerPage(segment)) {
    return undefined
  }

  let endpointUrl: string
  try {
    endpointUrl = decodeEndpointUrl(decodeURIComponent(segment))
  } catch {
    return undefined
  }

  // Anything that decodes but is not an absolute http(s) URL is not a graph
  // endpoint — a mistyped path, say — and must not be treated as one.
  if (!/^https?:\/\/\S+$/.test(endpointUrl)) {
    return undefined
  }

  const token = readAccessToken(endpointUrl)
  // Links this site used to build carried the view in a second segment; honour
  // it so an old bookmark still lands where it used to.
  const requestedPage = match?.[2]
  const page = requestedPage && isViewerPage(requestedPage)
    ? requestedPage
    : 'navigator'

  return {
    path: `/view/${page}`,
    endpointUrl: token ? redactAccessToken(endpointUrl) : endpointUrl,
    token: token ?? ''
  }
}
