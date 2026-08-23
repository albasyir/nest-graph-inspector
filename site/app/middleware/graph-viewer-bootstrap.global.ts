import { canOpenWithoutAccessToken } from '~/utils/inspector-access-token'
import {
  isViewerPage,
  resolveViewerBootstrap
} from '~/utils/viewer-bootstrap-link'

/**
 * Decides what a `/view/**` navigation actually resolves to.
 *
 * Two jobs, both of which have to happen before a page is created:
 *
 * 1. **Spend a printed link.** `plugins/graph-viewer-bootstrap.client.ts` has
 *    already cleaned `window.location`, but Nuxt's router plugin is ordered
 *    ahead of every user plugin and resolved its initial route from the
 *    original URL — so the router still intends to navigate to the link, and
 *    completing that navigation would write the endpoint and token straight
 *    back into the address bar. A redirect returned from a navigation guard
 *    aborts the pending navigation, so that route is never committed and the
 *    page is created once, against the final route.
 *
 * 2. **Make sure a viewer page has a graph, and may open it.** `/view/navigator`
 *    names a view, not a graph, so on a reload the store is empty and the graph
 *    has to come back from the tab's session. When there is no session — a fresh
 *    tab, or a link someone else was sent — there is nothing to show. When there
 *    is a session but no token, there is nothing to authenticate with. Either
 *    way the visitor belongs on `/view`. The one exception is a graph served
 *    from this site's own origin: the bundled demo, which gates nothing.
 */
export default defineNuxtRouteMiddleware((to) => {
  // Server rendering must not spend the link: redirecting there would drop the
  // token before the browser ever saw it, and keeping it would write a live
  // credential into the SSR payload. The client repeats this on hydration.
  if (import.meta.server || !to.path.startsWith('/view/')) {
    return
  }

  const graphStore = useGraphInspectorStore()

  // Exactly `/view/<page>`. A deeper path (`/view/navigator/anything`) matches no
  // page, so treating it as a viewer page would leave it stranded on the
  // bootstrap placeholder's spinner; it belongs in the redirect branch below.
  const segments = to.path.replace(/\/+$/, '').split('/')

  if (segments.length === 3 && isViewerPage(segments[2] ?? '')) {
    const endpointUrl = graphStore.restoreSession()

    if (!endpointUrl) {
      return navigateTo('/view', { replace: true })
    }

    // A viewer page is not reachable without the credential for the graph it
    // would show. The token is not in the URL any more, so the only way to hold
    // one is to have come through the printed link — which is the point.
    if (
      !graphStore.hasAccessToken
      && !canOpenWithoutAccessToken(endpointUrl, window.location.origin)
    ) {
      return navigateTo('/view', { replace: true })
    }

    return
  }

  const bootstrap = resolveViewerBootstrap(to.path)

  // Not a viewer page and not a usable link — a stale or mistyped URL.
  if (!bootstrap) {
    return navigateTo('/view', { replace: true })
  }

  graphStore.setSession(bootstrap.endpointUrl, bootstrap.token)

  return navigateTo(
    { path: bootstrap.path, query: to.query, hash: to.hash },
    { replace: true }
  )
})
