import ELK from 'elkjs/lib/elk-api.js'
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url'
import {
  createSharedElkEngineSource,
  failureSignal,
  type RunningElk
} from './elk-engine-source.ts'
import {
  AUTO_LAYOUT_ENGINE_READY_MEASURE,
  WARM_UP_LAYOUT_INPUT,
  loadBundledElk,
  recordUserTiming,
  toElkGraph
} from './module-graph-auto-layout.ts'

/**
 * The page's one ELK for the module graph's automatic layout, shared by every
 * viewer on the page, and running in a worker.
 *
 * The worker runs elkjs's own worker script as the build emitted it — copied
 * as it is, under the site's base path, by the `?url` import — next to
 * nothing but the small API that talks to it. Nothing here runs until a page
 * asks for a layout or a warm-up, which only happens in the browser.
 *
 * Only ever import this dynamically, as the graph viewer and
 * `startModuleLayoutWarmUp` do. Its worker script is an asset of this module's
 * chunk, and a page preloads the assets of every chunk it imports statically:
 * one static import from the graph viewer would have every page with a viewer
 * download the worker script whether it lays a graph out or not.
 *
 * The node tests cannot make a worker, so they drive the same source through
 * `createSharedElkEngineSource` with stand-ins.
 */
export const moduleLayoutEngine = createSharedElkEngineSource({
  startWorker: startElkWorker,
  // Where no worker can be made, the same ELK lays out on this thread, as it
  // did before it had a worker: slower to start, and nothing can stop it part
  // way, but the graph is still drawn as it should be.
  startOnThisThread: async (): Promise<RunningElk> => ({
    engine: await loadBundledElk(),
    stop: () => undefined
  }),
  warmUpGraph: toElkGraph(WARM_UP_LAYOUT_INPUT),
  // Measured in a fresh engine on the demo's graph: no warm-up leaves its
  // first layout at ~270 ms, one warm-up run at ~90 ms, three at ~60 ms — as
  // fast as a layout ever gets — for ~120 ms more of the worker's own time.
  warmUpRuns: 3,
  onReady: ({ start, end, runtime }) => recordUserTiming({
    name: AUTO_LAYOUT_ENGINE_READY_MEASURE,
    start,
    end,
    detail: { runtime }
  })
})

/**
 * ELK in a worker of its own. elkjs answers a worker's layouts but never
 * hears of the worker failing, so a worker whose script will not load — a
 * broken deploy, a policy against it — would leave its layouts waiting
 * forever; here they fail at once, and the source starts another next time.
 */
function startElkWorker(): RunningElk | undefined {
  if (typeof Worker === 'undefined') {
    return undefined
  }

  const worker = new Worker(elkWorkerUrl, { name: 'ngi-elk' })
  const { failure, fail } = failureSignal()
  worker.addEventListener('error', (event) => {
    // An error the worker did not catch can leave it running, but nothing
    // will use it again, so it is stopped rather than left idle.
    worker.terminate()
    fail(new Error(`ELK's worker failed: ${event.message || 'its script did not load'}`))
  }, { once: true })
  const elk = new ELK({ algorithms: ['layered'], workerFactory: () => worker })

  return {
    engine: {
      runtime: 'worker',
      layout: graph => Promise.race([elk.layout(graph), failure])
    },
    stop: () => {
      worker.terminate()
      fail(new Error('ELK\'s worker was stopped'))
    },
    failure
  }
}
