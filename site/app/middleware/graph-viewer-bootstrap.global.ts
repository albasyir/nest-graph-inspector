import { canOpenWithoutAccessToken } from '~/utils/inspector-access-token'
import {
  resolveViewerLink,
  resolveViewerPage
} from '~/utils/viewer-bootstrap-link'

/**
 * Decides what a `/view/**` navigation actually resolves to.
 *
 * Two jobs, both of which have to happen before a page is created:
 *
 * 1. **Spend a printed link** — or clear whatever stands where one would.
 *    `plugins/graph-viewer-bootstrap.client.ts` has already cleaned
 *    `window.location`, by the same `resolveViewerLink`, but Nuxt's router
 *    plugin is ordered ahead of every user plugin and resolved its initial route
 *    from the original URL — so the router still intends to navigate to the
 *    link, and completing that navigation would write the endpoint and token
 *    straight back into the address bar. A redirect returned from a navigation
 *    guard aborts the pending navigation, so that route is never committed and
 *    the page is created once, against the final route.
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
  if (import.meta.server) {
    return
  }

  const graphStore = useGraphInspectorStore()
  const link = resolveViewerLink(to.path)

  if (link) {
    // A link that cannot be spent hands over nothing, and leaves the tab's
    // session as it was.
    if (link.endpointUrl) {
      graphStore.setSession(link.endpointUrl, link.token)
    }

    // The page alone, as the plugin left the address bar: whatever travelled
    // beside the credential — the link's query or fragment — stays out of the
    // URL that analytics reads.
    return navigateTo(link.path, { replace: true })
  }

  if (!to.path.startsWith('/view/')) {
    return
  }

  // What is left is one of the viewer's own pages: `/view/` itself, exactly
  // `/view/<page>`, or a module deep dive at `/view/navigator/modules/<moduleId>`.
  const segments = to.path.replace(/\/+$/, '').split('/')
  const viewerPage = segments.length === 3
    ? resolveViewerPage(segments[2] ?? '')
    : undefined

  // A page under the name it had before it was renamed —
  // `/view/execution-sequence` is `/view/trace` now. Old links still carry it,
  // so it goes to the page it became, query and hash intact.
  if (viewerPage && viewerPage !== segments[2]) {
    return navigateTo(
      { path: `/view/${viewerPage}`, query: to.query, hash: to.hash },
      { replace: true }
    )
  }

  // `/view/` is `/view` itself, and the session belongs to the pages below it.
  if (segments.length === 2) {
    return navigateTo('/view', { replace: true })
  }

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
})
