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

    if (demo.status !== 'ready' || demo.endpointUrl !== endpointUrl) {
      // The endpoint died with the document that started the demo. Dropping it
      // before the restart is what stops anything rendered in the meantime from
      // building a URL out of it — and sending the old token to whatever host
      // that URL happens to name.
      graphStore.releaseEndpoint()

      if (!await demo.start()) {
        return ''
      }

      graphStore.setSession(demo.endpointUrl, demo.accessToken)
    }

    // The demo and this site are built from the same commit, so the version
    // acknowledgement the viewer asks for elsewhere has nothing to add here.
    graphStore.trustEndpointVersion(demo.endpointUrl)

    return demo.endpointUrl
  }

  return { demo, startupMessage, ensureEndpoint }
}
