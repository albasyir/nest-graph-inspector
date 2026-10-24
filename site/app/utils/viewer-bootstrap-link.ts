import { withoutBase } from 'ufo'
import { readAccessToken, redactAccessToken } from './inspector-access-token.ts'

/**
 * The viewer's own pages, which carry no graph identity in their URL.
 *
 * The graph being viewed lives in the store for the tab, not in the path — so
 * these paths mean "show me this view of whatever graph this tab is on".
 */
export const VIEWER_PAGES = ['navigator', 'issues', 'trace'] as const

export type ViewerPage = (typeof VIEWER_PAGES)[number]

/**
 * Names the viewer's pages used to have, and the page each one became.
 *
 * Links and bookmarks made before a rename still carry the old name: `trace`
 * was `execution-sequence` until it was renamed.
 */
const RENAMED_VIEWER_PAGES = new Map<string, ViewerPage>([
  ['execution-sequence', 'trace']
])

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
 * The viewer page a path segment names, by its current name or a former one.
 *
 * A former name resolves to the page it became, so a caller can tell the two
 * apart by comparing the result with the segment.
 */
export function resolveViewerPage(segment: string): ViewerPage | undefined {
  return isViewerPage(segment) ? segment : RENAMED_VIEWER_PAGES.get(segment)
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
 * own pages, under its current name or a former one, or a segment that is not
 * a graph endpoint at all.
 */
export function resolveViewerBootstrap(
  path: string
): ViewerBootstrap | undefined {
  const match = /^\/view\/([^/]+)(?:\/([^/]+))?\/?$/.exec(path)
  const segment = match?.[1]

  if (!segment || resolveViewerPage(segment)) {
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
  // it so an old bookmark still lands where it used to — on the page it became,
  // if that page has been renamed since.
  const requestedPage = match?.[2]
  const page = (requestedPage && resolveViewerPage(requestedPage)) || 'navigator'

  return {
    path: `/view/${page}`,
    // Redacted whenever the parameter is there at all: an empty first value is
    // what `readAccessToken` reports, and a second spelling can sit behind it.
    endpointUrl: token === undefined ? endpointUrl : redactAccessToken(endpointUrl),
    token: token ?? ''
  }
}

/**
 * Whether a path is one of the viewer's own pages: `/view` itself, a page under
 * its current name or a former one, or a module's deep dive beneath the
 * navigator. Nothing else under `/view/` is a page.
 */
export function isViewerPagePath(path: string): boolean {
  const [, root, page, ...rest] = path.replace(/\/+$/, '').split('/')

  if (root !== 'view') {
    return false
  }

  if (page === undefined) {
    return true
  }

  return Boolean(resolveViewerPage(page)) && (
    rest.length === 0
    || (page === 'navigator' && rest.length === 2 && rest[0] === 'modules')
  )
}

/**
 * What a path standing where a printed link would becomes, before anything
 * reads the address bar — `undefined` for every other path, which is left as
 * it is: the viewer's own pages, and everything outside `/view/`.
 *
 * The router matches paths without regard to case, so `/VIEW/<link>` reaches
 * the viewer as surely as `/view/<link>`. Only the spelling the library prints
 * is ever spent, landing on the page it names and handing over its graph. Any
 * other — `/view` in another case or after more than one slash, a link damaged
 * on its way here, or one arriving percent-encoded — may still carry the
 * token, so it lands on `/view` and hands over nothing.
 */
export function resolveViewerLink(path: string): ViewerBootstrap | undefined {
  if (!/^\/+view\//i.test(path) || isViewerPagePath(path)) {
    return undefined
  }

  const bootstrap = path.startsWith('/view/') ? resolveViewerBootstrap(path) : undefined

  return bootstrap ?? { path: '/view', endpointUrl: '', token: '' }
}

/**
 * What a page load on `pathname` does with the address bar before anything
 * reads it: the link it found and the `address` that replaces it, or
 * `undefined` to leave the address bar as it is.
 *
 * The route is read with `withoutBase`, exactly as Nuxt's router reads its first
 * route, so whatever the router will route — a doubled slash after the site's
 * base included — is caught here first.
 */
export function resolveViewerLanding(
  pathname: string,
  baseURL: string
): (ViewerBootstrap & { address: string }) | undefined {
  const link = resolveViewerLink(withoutBase(pathname, baseURL))
  const basePath = baseURL.endsWith('/') ? baseURL : `${baseURL}/`

  return link && { ...link, address: `${basePath}${link.path.slice(1)}` }
}
