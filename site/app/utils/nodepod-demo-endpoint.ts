/**
 * URL plumbing for the in-browser demo.
 *
 * The demo is the real demo application running inside the visitor's browser
 * on the nodepod runtime. Its HTTP servers are virtual: they answer through
 * `pod.request(port, ...)` rather than through the network. To let the viewer
 * talk to them with ordinary `fetch` calls, the site invents an address space
 * for them under its own origin and bridges requests that land there.
 *
 * A service worker would be the runtime's preferred route, but it registers
 * with `scope: "/"`, and the documentation site is served from a subpath on
 * GitHub Pages, which cannot answer with `Service-Worker-Allowed`.
 *
 * These addresses are same-origin by construction, which is what lets the
 * viewer talk to the demo with the same code it uses for an application on the
 * developer's own machine.
 */

/**
 * Route segment the virtual servers are addressed under. It is not served by
 * anything: requests to it are answered by the runtime in this tab.
 */
export const NODEPOD_ROUTE_SEGMENT = '__nodepod__'

const VIEWER_LINK_PATTERN = /\/view\/([A-Za-z0-9_-]{16,})/g
const MOUNT_BASE_PATTERN = new RegExp(
  `^(.*/${NODEPOD_ROUTE_SEGMENT}/\\d+)(?:/|$)`
)

/**
 * Decodes the base64url payload a viewer link carries.
 *
 * `atob` only reads standard base64, so the URL-safe alphabet is mapped back
 * and the padding the encoder dropped is restored before it is handed over.
 */
function decodeBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const paddingLength = (4 - (base64.length % 4)) % 4

  return atob(base64.padEnd(base64.length + paddingLength, '='))
}

/**
 * Trims trailing slashes from a path so a segment can be appended to it
 * without doubling the separator. The site's own base carries one; a mount
 * path built from it must not.
 */
function withoutTrailingSlash(path: string): string {
  return path.replace(/\/+$/, '')
}

/**
 * Reads the graph endpoint out of the startup log of the demo application.
 *
 * The inspector prints one viewer link per run, and that link is the only
 * place the access token is handed out, so the demo picks the endpoint up the
 * same way a developer does: from the link the application logged. The encoded
 * segment is matched rather than the sentence around it, so a reworded log
 * message does not take the demo down with it.
 */
export function readViewerLinkEndpoint(log: string): string | null {
  const matches = [...log.matchAll(VIEWER_LINK_PATTERN)]

  for (const match of matches.reverse()) {
    const encoded = match[1]

    if (!encoded) {
      continue
    }

    try {
      const url = new URL(decodeBase64Url(encoded))

      if (url.protocol === 'http:' || url.protocol === 'https:') {
        return url.toString()
      }
    } catch {
      continue
    }
  }

  return null
}

/**
 * Removes printed viewer links from an application log.
 *
 * The link the library prints is the one thing that hands out an access token,
 * and it carries it encoded rather than as a query parameter, so stripping a
 * token from the text does not reach it. A log written anywhere outside the tab
 * that owns the pod — CI output, a bug report — goes through here first.
 */
export function redactViewerLinks(log: string): string {
  return log.replace(VIEWER_LINK_PATTERN, '/view/<redacted>')
}

/**
 * Rewrites an endpoint the demo application printed for itself
 * (`http://localhost:53371/__graph-inspector`) into the address the browser can
 * reach it at, keeping the path.
 *
 * The query is dropped rather than carried over: the printed link is the one
 * thing that hands out an access token, and the viewer keeps that token in the
 * store and sends it as a header. A URL it builds never carries one.
 */
export function buildDemoEndpointUrl(params: {
  endpointUrl: string
  siteBaseUrl: string
}): string {
  const source = new URL(params.endpointUrl)
  const port = source.port || (source.protocol === 'https:' ? '443' : '80')
  const target = new URL(params.siteBaseUrl)

  target.pathname = `${withoutTrailingSlash(target.pathname)}/${NODEPOD_ROUTE_SEGMENT}/${port}${source.pathname}`
  target.search = ''
  target.hash = ''

  return target.toString()
}

/**
 * Path the inspector's sibling endpoints (`/direct-run`) live under for a given
 * graph endpoint.
 *
 * The library mounts them at the root of the application's own server, which
 * for the in-browser demo sits below the segment its port is addressed under.
 * Everything else — an inspector reached over the network — keeps resolving
 * them from the origin root, so this returns an empty prefix there.
 */
export function resolveInspectorMountBase(endpointUrl: string): string {
  if (!endpointUrl) {
    return ''
  }

  try {
    const { pathname } = new URL(endpointUrl)

    return MOUNT_BASE_PATTERN.exec(pathname)?.[1] ?? ''
  } catch {
    return ''
  }
}

/**
 * Resolves a request the site made into the virtual server it belongs to, or
 * `null` when the request is an ordinary one that must go to the network.
 */
export function readDemoRequestTarget(
  requestUrl: string,
  siteBaseUrl: string
): { port: number, path: string } | null {
  let url: URL
  let base: URL

  try {
    base = new URL(siteBaseUrl)
    url = new URL(requestUrl, base)
  } catch {
    return null
  }

  if (url.origin !== base.origin) {
    return null
  }

  const prefix = `${withoutTrailingSlash(base.pathname)}/${NODEPOD_ROUTE_SEGMENT}/`

  if (!url.pathname.startsWith(prefix)) {
    return null
  }

  const [portSegment, ...rest] = url.pathname.slice(prefix.length).split('/')
  const port = Number(portSegment)

  if (!Number.isInteger(port) || port <= 0) {
    return null
  }

  return { port, path: `/${rest.join('/')}${url.search}` }
}
