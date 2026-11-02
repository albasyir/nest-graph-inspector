import type { GraphOutput } from 'nest-graph-inspector'

/**
 * A graph opened from a file, kept for the tab so a reload can show it again.
 *
 * The counterpart of `inspector-graph-session.ts` for a graph with no endpoint
 * behind it: there is nothing to fetch it from again, so the graph itself is
 * kept, in `sessionStorage` — scoped to the tab and gone when it closes, like
 * the endpoint session, and never sent anywhere. A graph too large for the
 * tab's storage leaves only its name, so a reload can say which file to open
 * again rather than silently showing nothing.
 */

const STORAGE_KEY = 'nest-graph-inspector:graph-file'

/**
 * How large a graph the tab keeps, in characters of compact JSON. Session
 * storage holds about five million characters for the whole site, which the
 * saved layouts and the endpoint session share.
 */
export const MAX_STORED_GRAPH_CHARS = 1_500_000

/** Where a graph opened without an endpoint came from. */
export type GraphFileSource = {
  /** The file's own name, shown in the viewer's header. Never sent to analytics. */
  name: string
  /**
   * `file`: one the visitor opened. `example`: the demo application's graph,
   * exported at build time, which the site's previews and `/view?preview=true`
   * open without starting the demo.
   */
  kind: 'file' | 'example'
  /** Said beside the graph: a format newer than the viewer, for one. */
  notice?: string
}

type StoredGraphFile = GraphFileSource & {
  /** The graph as compact JSON; absent when it did not fit. */
  graph?: string
}

/** The slice of `Storage` this module needs, so tests can supply a fake. */
export type GraphFileStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The tab's session storage, or nothing when there is none to use. */
export function sessionGraphFileStorage(): GraphFileStorage | undefined {
  try {
    return globalThis.sessionStorage ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Keeps a graph file for the tab. Returns whether the graph itself was kept;
 * when it was not, only its name was, so a reload can ask for it again.
 */
export function writeGraphFileSession(
  source: GraphFileSource,
  graph: GraphOutput,
  storage: GraphFileStorage | undefined = sessionGraphFileStorage()
): boolean {
  if (!storage) {
    return false
  }

  const text = JSON.stringify(graph)
  if (text.length <= MAX_STORED_GRAPH_CHARS && trySet(storage, { ...source, graph: text })) {
    return true
  }

  // Not even the name fits: the record of the file before must not stay, or a
  // reload would bring back that file in place of this one.
  if (!trySet(storage, source)) {
    clearGraphFileSession(storage)
  }

  return false
}

/** The graph file this tab was on, if it was on one: with its graph, or only its name. */
export function readGraphFileSession(
  storage: GraphFileStorage | undefined = sessionGraphFileStorage()
): { source: GraphFileSource, graphText?: string } | undefined {
  let raw: string | null | undefined
  try {
    raw = storage?.getItem(STORAGE_KEY)
  } catch {
    return undefined
  }

  if (!raw) {
    return undefined
  }

  try {
    const stored: unknown = JSON.parse(raw)
    if (
      !stored
      || typeof stored !== 'object'
      || typeof (stored as StoredGraphFile).name !== 'string'
      || !(stored as StoredGraphFile).name
      || !['file', 'example'].includes((stored as StoredGraphFile).kind)
    ) {
      return undefined
    }

    const { graph, notice, name, kind } = stored as StoredGraphFile
    const source: GraphFileSource = typeof notice === 'string'
      ? { name, kind, notice }
      : { name, kind }

    return typeof graph === 'string' ? { source, graphText: graph } : { source }
  } catch {
    return undefined
  }
}

/** Forgets the graph file: the tab is no longer on it. */
export function clearGraphFileSession(
  storage: GraphFileStorage | undefined = sessionGraphFileStorage()
): void {
  try {
    storage?.removeItem(STORAGE_KEY)
  } catch {
    // The in-memory graph is what mattered, and it is already gone.
  }
}

/**
 * The key a graph file's layout is kept under: its kind and name, and a
 * fingerprint of the graph itself. Another `graph.json` opened in the same tab
 * does not inherit this one's arrangement, and this one, read back from the
 * tab after a reload, finds its own again. `graphText` is the graph as compact
 * JSON — the text the tab keeps it as, so a reload hands back the same text.
 */
export function graphFileKey(source: GraphFileSource, graphText: string): string {
  return `${source.kind}:${source.name}:${fingerprint(graphText)}`
}

/**
 * A cheap fingerprint of a text: its length and its 32-bit FNV-1a hash. It
 * only tells one graph from another under the same name; it guards nothing.
 */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }

  return `${text.length.toString(36)}-${(hash >>> 0).toString(36)}`
}

/**
 * Why Direct Run is off for a graph file: there is no application behind it
 * to call, and no trace history either, so the drawer says what would run it.
 */
export function describeGraphFileDirectRun(source: GraphFileSource): string {
  return source.kind === 'example'
    ? 'This is the demo application\'s static graph, with no application behind it to call. Press Load Example on the Graph Viewer start page to run the demo in this tab, then run its methods.'
    : 'This graph was opened from a file, with no application behind it to call. Open the Graph Viewer link your running application prints to run its methods.'
}

function trySet(storage: GraphFileStorage, record: StoredGraphFile): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(record))
    return true
  } catch {
    // Full, or unavailable: the caller falls back to keeping less.
    return false
  }
}
