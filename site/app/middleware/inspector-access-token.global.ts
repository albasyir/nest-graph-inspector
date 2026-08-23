import { parseViewerUrlParam } from '~/utils/inspector-access-token'

/**
 * Keeps the token-bearing route from ever being committed.
 *
 * `plugins/inspector-access-token.client.ts` has already cleaned
 * `window.location`, but Nuxt's router plugin is ordered ahead of every user
 * plugin and resolved its initial route from the original URL — so the router
 * still intends to navigate to the token-bearing one, and completing that
 * navigation would write the token straight back into the address bar.
 *
 * Redirecting from here stops that: a redirect returned from a navigation guard
 * aborts the pending navigation, so the token-bearing route is never committed
 * to history at all, and the page is created once — against the final route.
 */
export default defineNuxtRouteMiddleware((to) => {
  // Server rendering must not consume the token: redirecting there would drop
  // it before the browser ever saw it, and keeping it would write a live
  // credential into the SSR payload.
  if (import.meta.server || !to.path.startsWith('/view/')) {
    return
  }

  const param = Array.isArray(to.params.url) ? to.params.url[0] : to.params.url
  const { token, encoded, endpointUrl } = parseViewerUrlParam(param)

  // Undecodable: leave it alone and let the page redirect to /view.
  if (!encoded) {
    return
  }

  if (token) {
    // The plugin normally got here first; this covers a client-side navigation,
    // where no plugin runs.
    useGraphInspectorStore().rememberAccessToken(endpointUrl, token)
  }

  // Equal only when the segment carried no token and was already canonical.
  // Redirecting otherwise also normalises the padded standard base64 that an
  // older build of this site minted, so the route always matches the segment
  // the store re-encodes — which is what the viewer's own nav links compare
  // against.
  if (encoded === param) {
    return
  }

  const suffix = to.path.replace(/^\/view\/[^/]+/, '')

  return navigateTo(
    {
      path: `/view/${encoded}${suffix}`,
      query: to.query,
      hash: to.hash
    },
    { replace: true }
  )
})
