import { parseViewerUrlParam } from '~/utils/inspector-access-token'
import { storeAccessToken } from '~/utils/inspector-access-token-storage'

const VIEWER_PATH = /^\/view\/([^/]+)(.*)$/

/**
 * Takes the access token out of the address bar before anything reads it.
 *
 * The library prints `/view/<base64url(endpoint?__inspector_token=…)>`. That
 * link is a bootstrap credential: it has to be honoured once, and then the
 * token must not stay in the URL, because everything that follows reads the URL
 * — the router, every link built from the route, and the analytics client,
 * which captures `window.location` as `$current_url` the moment it initialises
 * and persists it.
 *
 * So this runs first (`enforce: 'pre'` sorts ahead of module plugins) and
 * rewrites the URL with `history.replaceState` before the router or PostHog has
 * looked at it. Doing it later — in middleware or a page — is too late for
 * analytics, and rewriting a route the router already owns would remount the
 * page and load the graph twice.
 */
export default defineNuxtPlugin({
  name: 'inspector-access-token',
  enforce: 'pre',
  setup() {
    const base = useRuntimeConfig().app.baseURL || '/'
    const basePath = base.endsWith('/') ? base : `${base}/`
    const { pathname, search, hash } = window.location

    if (!pathname.startsWith(basePath)) {
      return
    }

    const match = VIEWER_PATH.exec(pathname.slice(basePath.length - 1))
    if (!match?.[1]) {
      return
    }

    const { token, encoded, endpointUrl } = parseViewerUrlParam(match[1])
    if (!token) {
      return
    }

    storeAccessToken(endpointUrl, token)

    // `replaceState` rather than a push: the entry the printed link opened is
    // overwritten, so the token is gone from the back stack even when that link
    // was the first thing opened in the tab. It stays in the browser's own
    // history database — nothing client-side can retract that — but it expires
    // there with the token.
    window.history.replaceState(
      window.history.state,
      '',
      `${basePath}view/${encoded}${match[2]}${search}${hash}`
    )
  }
})
