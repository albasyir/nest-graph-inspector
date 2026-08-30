import { resolveDemoSessionAction } from '~/utils/nodepod-demo-session'

/**
 * Keeps a restored demo session usable.
 *
 * The demo's endpoint is answered by the fetch bridge of the tab that started
 * it and by nothing else, so a session restored in a new document — a reload, a
 * restored tab — names an address nothing will answer; and a tab left open long
 * enough holds a token that address has stopped accepting. Both are recovered
 * by running the demo again, which mints a fresh token on a fresh port, so
 * recovering means replacing the session rather than reusing it.
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
   * The endpoint a viewer page should load: the one it was given, a fresh one
   * from a restarted demo, or an empty string when there is nothing to show.
   */
  async function ensureEndpoint(endpointUrl: string): Promise<string> {
    if (!import.meta.client) {
      return endpointUrl
    }

    const action = resolveDemoSessionAction({
      endpointUrl,
      isDemoRunning: demo.status === 'ready',
      endpointRefusedToken: graphStore.endpointRequiresAccessToken
    })

    if (action === 'pass-through') {
      return endpointUrl
    }

    if (action !== 'reuse') {
      // The endpoint outlived whatever could answer it. Dropping it before the
      // boot is what stops anything rendered in the meantime from building a
      // URL out of it — and sending the old token to whatever host that URL
      // happens to name.
      graphStore.releaseEndpoint()

      // A refused token is the one case where an application is still running:
      // joining it would hand back the credential that was just refused, so it
      // is replaced instead.
      const started = action === 'restart'
        ? await demo.restart()
        : await demo.start()

      if (!started) {
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
