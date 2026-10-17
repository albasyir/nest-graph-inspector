import { writeGraphSession } from '~/utils/inspector-graph-session'
import { resolveViewerLanding } from '~/utils/viewer-bootstrap-link'

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
 * So this takes custody of the link and rewrites the address bar first — and
 * of anything else standing where a printed link would: one under another
 * spelling of `/view`, damaged on its way here, or arriving percent-encoded,
 * cannot be spent but can still carry the token. It reads the route the way
 * the router does, so it sees every link the router will route. It cannot beat
 * `nuxt:router` — nothing user-land can — which is why
 * `middleware/graph-viewer-bootstrap.global.ts` still has to redirect the route
 * the router already captured, by the same `resolveViewerLink`.
 */
export default defineNuxtPlugin({
  name: 'graph-viewer-bootstrap',
  enforce: 'pre',
  setup() {
    const landing = resolveViewerLanding(
      window.location.pathname,
      useRuntimeConfig().app.baseURL || '/'
    )

    if (!landing) {
      return
    }

    if (landing.endpointUrl) {
      writeGraphSession({ endpointUrl: landing.endpointUrl, token: landing.token })
    }

    // `replaceState` rather than a push: the entry the printed link opened is
    // overwritten, so neither the endpoint nor the token is a Back button away,
    // even when that link was the first thing opened in the tab. It stays in the
    // browser's own history database — nothing client-side can retract that —
    // but it expires there with the token. The query and fragment the link
    // arrived with are dropped too: whatever travelled beside a credential is
    // suspect as well.
    window.history.replaceState(window.history.state, '', landing.address)
  }
})
