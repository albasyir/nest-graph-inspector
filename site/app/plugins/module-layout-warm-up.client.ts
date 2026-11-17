import { withoutBase } from 'ufo'
import {
  drawsModuleGraphOnArrival,
  startModuleLayoutWarmUp
} from '~/utils/module-layout-warm-up'

/**
 * Starts ELK — the module graph's automatic layout — while a page that draws
 * the graph is still on its way, so ELK's download, compilation and first run
 * overlap the page's own loading instead of following it: on arriving at the
 * navigator, or at `/view?preview=true`, which opens the example there, and on
 * every later navigation to the navigator. A page that never draws the graph
 * never starts it, and ELK's module is imported only then, so it stays out of
 * every page's own bundle.
 *
 * It reads the address once `graph-viewer-bootstrap`, ordered ahead of every
 * plugin like this one, has spent any printed link in it — so a link arrives
 * here as the page it opens.
 */
export default defineNuxtPlugin({
  name: 'module-layout-warm-up',
  setup() {
    const arrival = new URL(window.location.href)
    if (drawsModuleGraphOnArrival({
      path: withoutBase(arrival.pathname, useRuntimeConfig().app.baseURL || '/'),
      preview: arrival.searchParams.get('preview')
    })) {
      startModuleLayoutWarmUp()
    }

    useRouter().beforeEach((to) => {
      if (drawsModuleGraphOnArrival({ path: to.path, preview: to.query.preview })) {
        startModuleLayoutWarmUp()
      }
    })
  }
})
