import { writeGraphSession } from '~/utils/inspector-graph-session'
import { resolveViewerBootstrap } from '~/utils/viewer-bootstrap-link'

/**
 * Spends the printed viewer link before anything else can read the address bar.
 *
 * `/view/<base64url(endpoint)>` carries the graph endpoint and, with it, a live
 * access token. Two things read `window.location` before any page or middleware
 * runs, and both would keep a copy:
 *
 * - PostHog initialises at plugin order 0 and persists `location.href` as
 *   `$initial_current_url` into `localStorage` *and* a cookie, which outlive
 *   the tab.
 * - Nuxt's own `nuxt:router` plugin (`enforce: 'pre'`, ordered ahead of every
 *   user plugin) captures the initial URL and force-navigates to it.
 *
 * So this takes custody of the link and rewrites the address bar first. It
 * cannot beat `nuxt:router` — nothing user-land can — which is why
 * `middleware/graph-viewer-bootstrap.global.ts` still has to redirect the route
 * the router already captured.
 */
export default defineNuxtPlugin({
  name: 'graph-viewer-bootstrap',
  enforce: 'pre',
  setup() {
    const base = useRuntimeConfig().app.baseURL || '/'
    const basePath = base.endsWith('/') ? base : `${base}/`
    const { pathname, search, hash } = window.location

    if (!pathname.startsWith(basePath)) {
      return
    }

    // `resolveViewerBootstrap` works in router paths, which exclude the base.
    const routePath = pathname.slice(basePath.length - 1)
    const bootstrap = resolveViewerBootstrap(routePath)

    if (!bootstrap) {
      return
    }

    writeGraphSession({
      endpointUrl: bootstrap.endpointUrl,
      token: bootstrap.token
    })

    // `replaceState` rather than a push: the entry the printed link opened is
    // overwritten, so neither the endpoint nor the token is a Back button away,
    // even when that link was the first thing opened in the tab. It stays in the
    // browser's own history database — nothing client-side can retract that —
    // but it expires there with the token.
    window.history.replaceState(
      window.history.state,
      '',
      `${basePath}${bootstrap.path.slice(1)}${search}${hash}`
    )
  }
})
