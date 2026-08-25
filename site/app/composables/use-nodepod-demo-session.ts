import { resolveInspectorMountBase } from '~/utils/nodepod-demo-endpoint'

/**
 * Keeps a restored demo session usable.
 *
 * The demo's endpoint is answered by the fetch bridge of the tab that started
 * it and by nothing else, so a session restored in a new document — a reload, a
 * restored tab — names an address nothing will answer. Starting the demo again
 * mints a fresh token on a fresh port, so recovering means replacing the
 * session rather than reusing it.
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
    if (!import.meta.client || !resolveInspectorMountBase(endpointUrl)) {
      return endpointUrl
    }

    // A pod that is still running but whose token the endpoint has started
    // refusing is as unusable as a pod that is gone: the demo's token expires
    // on the library's own schedule, and a tab left open outlives it.
    if (demo.status !== 'ready' || graphStore.endpointRequiresAccessToken) {
      // The endpoint died with the document that started the demo. Dropping it
      // before the restart is what stops anything rendered in the meantime from
      // building a URL out of it — and sending the old token to whatever host
      // that URL happens to name.
      graphStore.releaseEndpoint()

      if (!await demo.start()) {
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
