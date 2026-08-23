import { decodeEndpointUrl } from '~/utils/inspector-access-token'
import { resolveInspectorMountBase } from '~/utils/nodepod-demo-endpoint'

/**
 * Keeps a viewer URL that points at the in-browser demo working in a document
 * that has no demo running.
 *
 * That address is answered by the fetch bridge of the tab that started the
 * demo and by nothing else, so a reload, a restored tab or a shared link
 * reaches nothing at all. Starting the demo again mints a fresh access token on
 * a fresh port, so what the viewer is sent to is a new URL rather than the one
 * that was opened.
 */
export function useNodepodDemoRoute() {
  const demo = useNodepodDemoStore()
  const graphStore = useGraphInspectorStore()

  function isDemoEndpoint(encodedUrl: string) {
    try {
      return resolveInspectorMountBase(decodeEndpointUrl(encodedUrl)) !== ''
    } catch {
      return false
    }
  }

  /**
   * Message describing what the demo is doing, for as long as it is the reason
   * the viewer has nothing to show yet.
   */
  const startupMessage = computed(() =>
    demo.isBusy ? demo.statusLabel : undefined
  )

  /**
   * The encoded URL the page should load, or `null` when the page must stop
   * because it is being sent somewhere else.
   */
  async function resolveEncodedUrl(
    encodedUrl: string,
    routeSuffix = ''
  ): Promise<string | null> {
    if (!import.meta.client || !isDemoEndpoint(encodedUrl)) {
      return encodedUrl
    }

    if (demo.status !== 'ready' || demo.encodedEndpointUrl !== encodedUrl) {
      const started = await demo.start()

      if (!started) {
        // The demo store carries the failure, and /view is where it is shown
        // with the application's own console and a way to try again.
        await navigateTo('/view', { replace: true })
        return null
      }
    }

    // The demo and this site are built from the same commit, so the version
    // acknowledgement the viewer asks for elsewhere has nothing to add here.
    graphStore.trustEndpointVersion(demo.endpointUrl)

    if (demo.encodedEndpointUrl === encodedUrl) {
      return encodedUrl
    }

    await navigateTo(`/view/${demo.encodedEndpointUrl}${routeSuffix}`, {
      replace: true
    })

    return null
  }

  return { demo, startupMessage, resolveEncodedUrl }
}
