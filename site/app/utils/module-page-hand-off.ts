/**
 * Which module a `/view` address hands the preview's graph over to. `/view`
 * follows it to send the visitor on to that module's page
 * (`resolvePreviewModulePage`), and the ELK warm-up reads it to tell that page
 * from the navigator before any of the page's own code has loaded
 * (`drawsModuleGraphOnArrival`) — one rule, read the same way by both. It
 * imports nothing, so the warm-up's plugin carries it without the rest of a
 * module page's address.
 */

/** The `/view` query a preview names the module it hands over with. */
export const PREVIEW_MODULE_PARAMETER = 'module'

/**
 * The module `/view?preview=true&module=<name>` hands over to: `module` — the
 * first, when the router hands several over — while `preview` is exactly
 * `true`; `null` for any other address, which opens the viewer as it always
 * has. Only a preview's own link hands over to a module: the page shows
 * whatever graph the tab holds, and only a preview's hand-off puts it there.
 */
export function readHandedOverModule(query: Readonly<Record<string, unknown>>): string | null {
  if (query.preview !== 'true') {
    return null
  }

  const moduleName = readFirstQueryValue(query[PREVIEW_MODULE_PARAMETER])
  return moduleName === '' ? null : moduleName
}

/** A query value as the router hands it over: a string, or the first of several. */
export function readFirstQueryValue(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  const [first] = Array.isArray(value) ? value : []
  return typeof first === 'string' ? first : ''
}
