/**
 * The graph this tab is looking at, and the credential for it.
 *
 * Neither is in the URL any more: `/view/navigator` says which view to show,
 * not which graph. So the tab has to remember the graph itself, or a reload
 * would have nothing to restore and would bounce back to `/view`.
 *
 * Kept in memory *and* in `sessionStorage`: memory alone would not survive a
 * reload, and session storage alone is not always available — Safari's private
 * mode throws on access — which would otherwise make the printed link fail
 * outright rather than just fail to survive a reload.
 *
 * `sessionStorage` rather than `localStorage` on purpose: it is scoped to the
 * tab and cleared when the tab closes. Note that duplicating a tab copies it,
 * so "tab-scoped" is not the same as "unshareable".
 */

const STORAGE_KEY = 'nest-graph-inspector:session'

export type GraphSession = {
  /** Graph endpoint URL, never carrying a token. */
  endpointUrl: string
  /** Access token for that endpoint, empty when it needs none. */
  token: string
}

/** The slice of `Storage` this module needs, so tests can supply a fake. */
export type GraphSessionStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>

let cached: GraphSession | undefined

/**
 * The tab's session storage, or nothing when there is none to use.
 *
 * Absent during server rendering, and access can throw outright, so a missing
 * store is a normal outcome rather than an error.
 */
export function sessionGraphStorage(): GraphSessionStorage | undefined {
  try {
    return globalThis.sessionStorage ?? undefined
  } catch {
    return undefined
  }
}

function readRecord(
  storage: GraphSessionStorage | undefined
): GraphSession | undefined {
  if (!storage) {
    return undefined
  }

  let raw: string | null
  try {
    raw = storage.getItem(STORAGE_KEY)
  } catch {
    return undefined
  }

  if (!raw) {
    return undefined
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    if (
      !parsed
      || typeof parsed !== 'object'
      || typeof (parsed as GraphSession).endpointUrl !== 'string'
      || !(parsed as GraphSession).endpointUrl
      || typeof (parsed as GraphSession).token !== 'string'
    ) {
      return undefined
    }

    return parsed as GraphSession
  } catch {
    return undefined
  }
}

/** The graph this tab is on, if it is on one. */
export function readGraphSession(
  storage: GraphSessionStorage | undefined = sessionGraphStorage()
): GraphSession | undefined {
  return cached ?? readRecord(storage)
}

/** Remembers the graph this tab is on, for the lifetime of the tab. */
export function writeGraphSession(
  session: GraphSession,
  storage: GraphSessionStorage | undefined = sessionGraphStorage()
): void {
  if (!session.endpointUrl) {
    return
  }

  cached = session

  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(session))
  } catch {
    // A full or unavailable store costs the tab its graph on reload, which the
    // developer recovers by reopening the printed link. Failing the render is
    // not recoverable.
  }
}

/** Forgets the graph and its credential — the tab is no longer on a graph. */
export function clearGraphSession(
  storage: GraphSessionStorage | undefined = sessionGraphStorage()
): void {
  cached = undefined

  try {
    storage?.removeItem(STORAGE_KEY)
  } catch {
    // Nothing to do: the copy that mattered is the in-memory one, already gone.
  }
}
