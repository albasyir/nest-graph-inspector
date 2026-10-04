/**
 * A module name as one URL path segment, and back.
 *
 * Module names come from the host application and are not constrained to
 * identifiers: a dynamic module or a `nestCoreModuleName` override can carry a
 * slash, a space, or a `%`. The id must survive being a single segment of a
 * route, so it escapes everything `encodeURIComponent` does, plus the
 * sub-delimiters it leaves alone (`!'()*`), plus a name made only of dots —
 * `.` and `..` are dot-segments a router or browser would resolve away.
 */

const RESERVED_SUB_DELIMITERS = /[!'()*]/g
const DOT_SEGMENT = /^\.+$/

/** URL-safe id for a module name; `decodeModuleId` reverses it exactly. */
export function encodeModuleId(name: string): string {
  const encoded = encodeURIComponent(name).replace(
    RESERVED_SUB_DELIMITERS,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )

  return DOT_SEGMENT.test(encoded) ? encoded.replaceAll('.', '%2E') : encoded
}

/**
 * The module name an id was encoded from.
 *
 * Throws `URIError` for an id with a malformed escape (`%E0%A4%A`), which no
 * `encodeModuleId` output contains — so a caller reading one from the address
 * bar should treat that as "no such module" rather than guess at a name.
 */
export function decodeModuleId(id: string): string {
  return decodeURIComponent(id)
}
