/**
 * When the navigator's Bright Line starts on, and what the tab remembers once
 * the visitor says otherwise.
 *
 * Bright Line starts on for a graph with fewer than
 * {@link BRIGHT_LINE_LARGE_GRAPH_MODULE_COUNT} modules and off from there. The
 * cutoff is a chosen default for what the navigator opens with, not a measured
 * performance limit. The toggle is offered either way, and while Bright Line is
 * on for a graph at or past the cutoff, an advisory says it may slow the view.
 *
 * A choice the visitor makes outranks that default, and is kept per graph for
 * the life of the tab, in memory and in `sessionStorage`: a refresh or a reload
 * of the same graph keeps it, another graph starts from its own, and coming
 * back to the first finds it again.
 */

/** A graph with at least this many modules starts with Bright Line off. */
export const BRIGHT_LINE_LARGE_GRAPH_MODULE_COUNT = 10

/** The advisory beside the toggle while Bright Line is on past the cutoff. */
export const BRIGHT_LINE_LARGE_GRAPH_WARNING
  = 'Bright Line mungkin memperlambat tampilan pada graph besar.'

const STORAGE_KEY_PREFIX = 'nest-graph-inspector:bright-line:'
const STORED_ON = 'on'
const STORED_OFF = 'off'

/** The slice of `Storage` this module needs, so tests can supply a fake. */
export type BrightLineStorage = Pick<Storage, 'getItem' | 'setItem'>

const cached = new Map<string, boolean>()

/** How many modules a graph has, as `GraphOutput.modules` lists them. */
export function countGraphModules(
  graph: { modules: Readonly<Record<string, unknown>> } | null | undefined
): number {
  return graph ? Object.keys(graph.modules).length : 0
}

/** Whether a graph is at or past the cutoff, where Bright Line starts off. */
export function isLargeBrightLineGraph(moduleCount: number): boolean {
  return moduleCount >= BRIGHT_LINE_LARGE_GRAPH_MODULE_COUNT
}

/**
 * Whether Bright Line is on: what the visitor chose for this graph, or — while
 * `choice` is `null` — on for a small graph and off for a large one.
 */
export function resolveShowBrightLine({
  moduleCount,
  choice
}: {
  moduleCount: number
  choice: boolean | null
}): boolean {
  return choice ?? !isLargeBrightLineGraph(moduleCount)
}

/** Whether to show the advisory: Bright Line is on, at or past the cutoff. */
export function shouldWarnAboutBrightLine({
  moduleCount,
  isOn
}: {
  moduleCount: number
  isOn: boolean
}): boolean {
  return isOn && isLargeBrightLineGraph(moduleCount)
}

/**
 * What a choice is kept under for a graph endpoint: its origin and path.
 *
 * Nothing that can authenticate survives it. The query — where a printed link
 * carries its access token — goes, and so do user info and the fragment, so a
 * storage key never holds a credential, and the same graph reached with a
 * fresh token keeps its choice. Empty for anything that is not an http(s) URL,
 * which is then kept for nobody.
 */
export function brightLineGraphKey(endpointUrl: string): string {
  if (!endpointUrl) {
    return ''
  }

  try {
    const url = new URL(endpointUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return ''
    }

    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch {
    return ''
  }
}

/** The tab's session storage, or nothing when there is none to use. */
export function sessionBrightLineStorage(): BrightLineStorage | undefined {
  try {
    return globalThis.sessionStorage ?? undefined
  } catch {
    return undefined
  }
}

/** What the visitor chose for a graph in this tab, or `null` if nothing. */
export function readBrightLineChoice(
  endpointUrl: string,
  storage: BrightLineStorage | undefined = sessionBrightLineStorage()
): boolean | null {
  const key = brightLineGraphKey(endpointUrl)
  if (!key) {
    return null
  }

  const memory = cached.get(key)
  if (memory !== undefined) {
    return memory
  }

  let raw: string | null
  try {
    raw = storage?.getItem(STORAGE_KEY_PREFIX + key) ?? null
  } catch {
    return null
  }

  if (raw === STORED_ON) {
    return true
  }

  return raw === STORED_OFF ? false : null
}

/** Keeps the visitor's choice for a graph, for the lifetime of the tab. */
export function writeBrightLineChoice(
  endpointUrl: string,
  isOn: boolean,
  storage: BrightLineStorage | undefined = sessionBrightLineStorage()
): void {
  const key = brightLineGraphKey(endpointUrl)
  if (!key) {
    return
  }

  cached.set(key, isOn)

  try {
    storage?.setItem(STORAGE_KEY_PREFIX + key, isOn ? STORED_ON : STORED_OFF)
  } catch {
    // A full or unavailable store costs the choice on reload; the copy in
    // memory still serves this page.
  }
}
