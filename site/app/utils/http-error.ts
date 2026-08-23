/**
 * Reading what a failed request actually said.
 *
 * The inspector answers a rejection with a JSON body naming the reason, which
 * is far more use to a developer than the transport's own message. Both shapes
 * arrive as `unknown` from a fetch rejection, so both are probed defensively.
 */

/** Message the inspector returned, in preference to a generic transport error. */
export function readResponseError(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return ''
  }

  const data = (error as { data?: unknown }).data
  const message = (data as { error?: unknown } | undefined)?.error

  return typeof message === 'string' ? message : ''
}

/** HTTP status a request failed with, or `0` when it never got one. */
export function readStatusCode(error: unknown): number {
  const statusCode = (error as { statusCode?: unknown } | null)?.statusCode

  return typeof statusCode === 'number' ? statusCode : 0
}
