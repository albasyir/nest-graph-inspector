import { readHandedOverModule } from './module-page-hand-off.ts'

/**
 * Whether arriving at `path` draws the module graph straight away, so ELK —
 * which lays it out — is worth starting while the page itself is still
 * loading: the navigator, and `/view?preview=true`, which opens the example
 * there — unless the preview handed a module over with it (`?module=`), which
 * opens that module's page instead. `preview` and `module` are what the
 * address carries, read by `/view`'s own rule (`readHandedOverModule`). The
 * other viewer pages, a module's page and every page outside the viewer draw
 * no module graph on arrival — a module's page lays itself out without ELK —
 * and a documentation preview starts ELK when it lays its own graph out.
 */
export function drawsModuleGraphOnArrival({
  path,
  preview,
  module
}: {
  path: string
  preview: unknown
  module?: unknown
}): boolean {
  const page = path.replace(/\/+$/, '')

  return page === '/view/navigator'
    || (page === '/view' && preview === 'true' && readHandedOverModule({ preview, module }) === null)
}

/**
 * Starts the page's one ELK and warms it, for a page about to draw the module
 * graph, so its download, compilation and first run overlap whatever the page
 * is still doing. Does nothing on the server, or when ELK is already running.
 *
 * ELK's module is imported here, never statically — see
 * `module-layout-engine.ts` — so a page that only warms ELK up need not know
 * it must not be; the graph viewer imports it the same way for its layouts. A
 * failed import costs nothing: the layout imports ELK again, and falls back to
 * the simple arrangement if that fails too.
 */
export function startModuleLayoutWarmUp(): void {
  if (!import.meta.client) {
    return
  }

  void import('./module-layout-engine.ts').then(
    engine => engine.moduleLayoutEngine.warmUp(),
    () => undefined
  )
}
