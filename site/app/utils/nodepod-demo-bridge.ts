/**
 * Conversions between the browser's `fetch` types and the ones the in-browser
 * runtime speaks, used by the bridge in `~/stores/nodepod-demo`.
 */

/** Longest a single bridged request may take before it is given up on. */
export const BRIDGE_TIMEOUT_MS = 30_000

// eslint-disable-next-line no-control-regex -- ANSI colour codes are control characters
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

export function toRequestBody(
  body: BodyInit | null | undefined
): string | Uint8Array | undefined {
  if (body === null || body === undefined) {
    return undefined
  }

  if (typeof body === 'string') {
    return body
  }

  if (body instanceof URLSearchParams) {
    return body.toString()
  }

  if (body instanceof Uint8Array) {
    return body
  }

  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body)
  }

  throw new TypeError(
    'The in-browser demo can only be sent text or binary request bodies.'
  )
}

/**
 * The runtime answers with its own `Buffer`, which is a `Uint8Array` in the
 * browser but does not have to be, so the bytes are copied out defensively.
 */
export function toResponseBody(body: unknown): BodyInit | null {
  if (body === null || body === undefined) {
    return null
  }

  if (typeof body === 'string') {
    return body
  }

  if (body instanceof Uint8Array) {
    return body.slice()
  }

  if (Array.isArray(body)) {
    return new Uint8Array(body)
  }

  if (typeof body === 'object' && 'length' in body) {
    return Uint8Array.from(body as ArrayLike<number>)
  }

  return String(body)
}

/**
 * Bounds a bridged request and lets the caller cancel it.
 *
 * The runtime answers in this tab rather than over the network, so nothing
 * else would ever time it out, and an unmounted component or an aborted
 * `fetch` would otherwise wait on it forever.
 */
export function withDeadline<T>(
  pending: Promise<T>,
  signal: AbortSignal | null,
  timeoutMs = BRIDGE_TIMEOUT_MS
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DOMException('The demo application did not answer in time.', 'TimeoutError'))
    }, timeoutMs)

    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('The demo request was aborted.', 'AbortError'))
    }

    if (signal?.aborted) {
      onAbort()
      return
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    pending.then(
      (value) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })
}

export function toResponseHeaders(headers: unknown): Headers {
  const result = new Headers()

  if (!headers || typeof headers !== 'object') {
    return result
  }

  for (const [name, value] of Object.entries(
    headers as Record<string, string | string[] | undefined>
  )) {
    // The bridge hands the body over already decoded, so the transfer headers
    // that described it on the way out would only contradict the Response.
    if (
      value === undefined
      || name.toLowerCase() === 'content-length'
      || name.toLowerCase() === 'content-encoding'
    ) {
      continue
    }

    for (const entry of Array.isArray(value) ? value : [value]) {
      result.append(name, entry)
    }
  }

  return result
}
