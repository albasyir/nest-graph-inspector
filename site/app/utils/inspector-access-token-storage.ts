/**
 * The tab's copy of the inspector access token.
 *
 * The token arrives once, in the bootstrap link, and is taken straight out of
 * the URL — so a reload has nothing left to rebuild it from. This is what the
 * reload reads instead.
 *
 * Kept in memory *and* in `sessionStorage`: memory alone would not survive a
 * reload, and session storage alone is not always available (Safari's private
 * mode throws on access), which would otherwise make the bootstrap link fail
 * outright rather than just fail to survive a reload.
 *
 * `sessionStorage` rather than `localStorage` on purpose — it is scoped to the
 * tab and cleared when the tab closes. Note that duplicating a tab copies it,
 * so "tab-scoped" is not the same as "unshareable".
 *
 * One endpoint at a time, deliberately: the viewer only ever authenticates
 * against the endpoint it is showing, so remembering more would just mean more
 * live credentials sitting behind one well-known storage key.
 */

const STORAGE_KEY = 'nest-graph-inspector:access-token'

type AccessTokenRecord = {
  endpointUrl: string
  token: string
}

/** The slice of `Storage` this module needs, so tests can supply a fake. */
export type AccessTokenStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem'
>

let cached: AccessTokenRecord | undefined

/**
 * The tab's session storage, or nothing when there is none to use.
 *
 * Absent during server rendering, and access can throw outright, so a missing
 * store is a normal outcome rather than an error.
 */
export function sessionAccessTokenStorage(): AccessTokenStorage | undefined {
  try {
    return globalThis.sessionStorage ?? undefined
  } catch {
    return undefined
  }
}

function readRecord(
  storage: AccessTokenStorage | undefined
): AccessTokenRecord | undefined {
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
      || typeof (parsed as AccessTokenRecord).endpointUrl !== 'string'
      || typeof (parsed as AccessTokenRecord).token !== 'string'
    ) {
      return undefined
    }

    return parsed as AccessTokenRecord
  } catch {
    return undefined
  }
}

function writeRecord(
  storage: AccessTokenStorage | undefined,
  record: AccessTokenRecord | undefined
): void {
  if (!storage) {
    return
  }

  try {
    if (!record) {
      storage.removeItem(STORAGE_KEY)
      return
    }

    storage.setItem(STORAGE_KEY, JSON.stringify(record))
  } catch {
    // A full or unavailable store costs the tab its token on reload, which the
    // developer recovers by reopening the printed link. Failing the render is
    // not recoverable.
  }
}

/** The token this tab holds for `endpointUrl`, if any. */
export function readStoredAccessToken(
  endpointUrl: string,
  storage: AccessTokenStorage | undefined = sessionAccessTokenStorage()
): string {
  if (!endpointUrl) {
    return ''
  }

  if (cached?.endpointUrl === endpointUrl) {
    return cached.token
  }

  const record = readRecord(storage)

  return record?.endpointUrl === endpointUrl ? record.token : ''
}

/** Takes custody of the token a bootstrap link carried. */
export function storeAccessToken(
  endpointUrl: string,
  token: string,
  storage: AccessTokenStorage | undefined = sessionAccessTokenStorage()
): void {
  if (!endpointUrl) {
    return
  }

  if (!token) {
    forgetAccessToken(endpointUrl, storage)
    return
  }

  cached = { endpointUrl, token }
  writeRecord(storage, cached)
}

/** Drops the token for `endpointUrl`, for instance once it has been rejected. */
export function forgetAccessToken(
  endpointUrl: string,
  storage: AccessTokenStorage | undefined = sessionAccessTokenStorage()
): void {
  if (!endpointUrl) {
    return
  }

  if (cached?.endpointUrl === endpointUrl) {
    cached = undefined
  }

  if (readRecord(storage)?.endpointUrl === endpointUrl) {
    writeRecord(storage, undefined)
  }
}
