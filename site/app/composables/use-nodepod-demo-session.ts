import { resolveDemoSessionAction } from '~/utils/nodepod-demo-session'

/**
 * Keeps a restored demo session honest, without ever starting the demo.
 *
 * The demo's endpoint is answered by the fetch bridge of the tab that started
 * it and by nothing else, so a session restored in a new document — a reload, a
 * restored tab — names an address nothing will answer; and a tab left open long
 * enough holds a token that address has stopped accepting. A viewer page does
 * not boot the demo to recover either one: only the landing page starts it
 * unasked, and `/view` when the visitor asks. So a dead session is forgotten
 * and the page sends the visitor to the `/view` landing card, while a demo this
 * tab is already running — or starting — is reused as it is.
 */
export function useNodepodDemoSession() {
  const demo = useNodepodDemoStore()
  const graphStore = useGraphInspectorStore()

  /**
   * Message describing what the demo is doing, for as long as it is the reason
   * the viewer has nothing to show yet.
   */
  const startupMessage = computed(() =>
    demo.isBusy ? demo.statusLabel : undefined
  )

  /**
   * The endpoint a viewer page should load: the one it was given, the running
   * demo's, or an empty string when there is nothing to show — the caller then
   * sends the visitor to `/view`.
   */
  async function ensureEndpoint(endpointUrl: string): Promise<string> {
    if (!import.meta.client) {
      return endpointUrl
    }

    const action = resolveDemoSessionAction({
      endpointUrl,
      isDemoRunning: demo.isRunning,
      isDemoStarting: demo.isBusy,
      endpointRefusedToken: graphStore.endpointRequiresAccessToken
    })

    if (action === 'pass-through') {
      return endpointUrl
    }

    if (action !== 'reuse') {
      // The endpoint outlived whatever answered it, or nothing answers it yet.
      // Dropping it first is what stops anything rendered in the meantime from
      // building a URL out of it — and sending the old token to whatever host
      // that URL happens to name — and keeps a reload from restoring it.
      graphStore.releaseEndpoint()

      // A refused token is the one case where an application is still running,
      // and it goes with the session: `/view` would otherwise join it and hand
      // the visitor the credential that was just refused.
      if (action === 'stop') {
        demo.stop()
      }

      // Joining waits for a start already in flight; it never boots one.
      if (action !== 'join' || !await demo.join()) {
        return ''
      }
    }

    // Always the running pod's credential, never the one the session was
    // restored with: the demo's address is the same on every boot, so matching
    // URLs prove nothing about which pod minted the token being held — and a
    // token the endpoint has already refused is only cleared here.
    graphStore.setSession(demo.endpointUrl, demo.accessToken)

    // The demo and this site are built from the same commit, so the version
    // acknowledgement the viewer asks for elsewhere has nothing to add here.
    graphStore.trustEndpointVersion(demo.endpointUrl)

    return demo.endpointUrl
  }

  return { demo, startupMessage, ensureEndpoint }
}
