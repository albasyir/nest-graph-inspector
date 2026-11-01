import type { GraphOutput } from 'nest-graph-inspector'

/**
 * Whether the viewer can show what an endpoint returned.
 *
 * Two separate questions, and the answers lead to different UI: a graph in a
 * shape this viewer no longer reads means the library needs upgrading, while an
 * endpoint serving the graph itself at the old path means it predates the
 * inspector's own endpoints entirely.
 */

/** A graph output old enough that it lacks fields this viewer relies on. */
export type LegacyGraphOutput = Partial<GraphOutput>

/** Below this, the viewer cannot render the graph it was given. */
export const MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION = 3

/**
 * The newest graph output version this viewer was built against: the
 * library's `GRAPH_OUTPUT_SCHEMA_VERSION`, which the site can only restate,
 * since it imports nothing from the library at runtime. A newer graph still
 * renders, as it does from an endpoint — the hosted viewer is normally the
 * newest — but a graph file opened from disk says when it is newer than this.
 */
export const NEWEST_KNOWN_GRAPH_OUTPUT_VERSION = 3

/**
 * Whether a response is a graph output served in place of the endpoint payload.
 *
 * Older versions answered the endpoint path with the graph itself, so finding
 * one there is how the viewer recognises a library that needs upgrading rather
 * than an address that is simply wrong.
 */
export function isLegacyGraphOutput(value: unknown): value is LegacyGraphOutput {
  return Boolean(
    value
    && typeof value === 'object'
    && 'version' in value
    && 'root' in value
    && 'modules' in value
  )
}

/**
 * A graph output's schema version as a number, or `null` when what the JSON
 * held is not a version at all.
 */
export function parseGraphOutputVersion(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null
  }

  const parsedVersion = Number.parseInt(String(value), 10)
  return Number.isFinite(parsedVersion) ? parsedVersion : null
}

/**
 * Whether a graph output's schema version is one this viewer renders.
 *
 * The version arrives as whatever JSON held, so a string, a number and nonsense
 * all have to be handled — and nonsense is not supported.
 */
export function isSupportedGraphOutputVersion(value: unknown): boolean {
  const parsedVersion = parseGraphOutputVersion(value)
  return (
    parsedVersion !== null
    && parsedVersion >= MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION
  )
}
