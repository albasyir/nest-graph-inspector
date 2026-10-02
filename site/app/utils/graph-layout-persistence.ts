import type { GraphLayout } from 'nest-graph-inspector'

/**
 * Where a graph's layout is kept when the inspector cannot keep it.
 *
 * A live application saves the layout to a file through its own layout
 * endpoint. A static graph read from disk has no server to save to, the
 * in-browser demo's file system disappears with the tab, and a library from
 * before layouts existed has no such endpoint — so for those the tab keeps the
 * layout itself, in memory and in `sessionStorage`, keyed by endpoint, and the
 * visitor can download it as a file to commit.
 */

const STORAGE_KEY_PREFIX = 'nest-graph-inspector:layout:'

/** The slice of `Storage` this module needs, so tests can supply a fake. */
export type GraphLayoutStorage = Pick<Storage, 'getItem' | 'setItem'>

/** The file name the library saves to by default, so a download drops in. */
export const GRAPH_LAYOUT_FILE_NAME = 'nest-graph-layout.json'

const cached = new Map<string, GraphLayout>()

/** The tab's session storage, or nothing when there is none to use. */
export function sessionLayoutStorage(): GraphLayoutStorage | undefined {
  try {
    return globalThis.sessionStorage ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Exactly how the library writes the file — two spaces and a trailing newline —
 * so a downloaded layout and a saved one diff as the same file.
 */
export function serializeGraphLayout(layout: GraphLayout): string {
  return `${JSON.stringify(layout, null, 2)}\n`
}

/**
 * Whether a value has the shape of a version 1 layout.
 *
 * The library validates the file strictly; this only guards the viewer
 * against whatever a session or an unexpected response holds, so it checks
 * what the viewer reads and nothing more.
 */
export function isGraphLayout(value: unknown): value is GraphLayout {
  if (!isRecord(value) || value.version !== '1' || !isRecord(value.modules)) {
    return false
  }

  return Object.values(value.modules).every(
    module =>
      isRecord(module)
      && isPosition(module.position)
      && (module.isCollapsed === undefined
        || typeof module.isCollapsed === 'boolean')
      && (module.items === undefined
        || (isRecord(module.items)
          && Object.values(module.items).every(isPosition)))
  )
}

/** The layout this tab kept for an endpoint, if it kept one. */
export function readStoredLayout(
  endpointUrl: string,
  storage: GraphLayoutStorage | undefined = sessionLayoutStorage()
): GraphLayout | null {
  if (!endpointUrl) {
    return null
  }

  const memory = cached.get(endpointUrl)
  if (memory) {
    return memory
  }

  let raw: string | null
  try {
    raw = storage?.getItem(STORAGE_KEY_PREFIX + endpointUrl) ?? null
  } catch {
    return null
  }

  if (!raw) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    return isGraphLayout(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Keeps a layout for an endpoint, for the lifetime of the tab. */
export function writeStoredLayout(
  endpointUrl: string,
  layout: GraphLayout,
  storage: GraphLayoutStorage | undefined = sessionLayoutStorage()
): void {
  if (!endpointUrl) {
    return
  }

  cached.set(endpointUrl, layout)

  try {
    storage?.setItem(STORAGE_KEY_PREFIX + endpointUrl, JSON.stringify(layout))
  } catch {
    // A full or unavailable store costs the layout on reload; the copy in
    // memory still serves this page, and the visitor can download it.
  }
}

/**
 * What a failed layout request said. The layout routes answer with `message`
 * and, for a layout that failed validation, the reasons in `errors`.
 */
export function readLayoutResponseError(error: unknown): string {
  const data = isRecord(error) ? error.data : undefined
  if (!isRecord(data) || typeof data.message !== 'string') {
    return ''
  }

  const reasons = Array.isArray(data.errors)
    ? data.errors.filter((reason): reason is string => typeof reason === 'string')
    : []

  return reasons.length
    ? `${data.message}: ${reasons.join('; ')}`
    : data.message
}

function isPosition(value: unknown): boolean {
  return (
    isRecord(value)
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
