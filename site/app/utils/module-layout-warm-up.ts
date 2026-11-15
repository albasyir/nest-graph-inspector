/**
 * Whether arriving at `path` draws the module graph straight away, so ELK —
 * which lays it out — is worth starting while the page itself is still
 * loading: the navigator, and `/view?preview=true`, which opens the example
 * there. `preview` is the `?preview` the address carries, read as `/view`
 * reads it. The other viewer pages, a module's deep dive and every page
 * outside the viewer draw no module graph on arrival; a documentation preview
 * starts ELK when it lays its own graph out.
 */
export function drawsModuleGraphOnArrival({
  path,
  preview
}: {
  path: string
  preview: unknown
}): boolean {
  const page = path.replace(/\/+$/, '')

  return page === '/view/navigator' || (page === '/view' && preview === 'true')
}

/**
 * Starts the page's one ELK and warms it, for a page about to draw the module
 * graph, so its download, compilation and first run overlap whatever the page
 * is still doing. Does nothing on the server, or when ELK is already running.
 *
 * ELK's module is imported here, never statically — see
 * `module-layout-engine.ts` — so no caller has to know it must not be. A
 * failed import costs nothing: the layout imports ELK again, and falls back to
 * rows if that fails too.
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
