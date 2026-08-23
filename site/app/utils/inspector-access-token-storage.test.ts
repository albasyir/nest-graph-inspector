import { strict as assert } from 'node:assert'
import {
  forgetAccessToken,
  readStoredAccessToken,
  sessionAccessTokenStorage,
  storeAccessToken,
  type AccessTokenStorage
} from './inspector-access-token-storage.ts'

const STORAGE_KEY = 'nest-graph-inspector:access-token'

function fakeStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial))

  return {
    entries,
    storage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value)
      },
      removeItem: (key: string) => {
        entries.delete(key)
      }
    } satisfies AccessTokenStorage
  }
}

const ENDPOINT = 'http://0.0.0.0:53371/__graph-inspector'
const OTHER_ENDPOINT = 'http://0.0.0.0:4000/__graph-inspector'
const TOKEN = 'ngi1.eyJpYXQiOjEsImV4cCI6Mn0.s1gn-atur_e'

// A reload has no token in the URL left to recover from, so the tab has to have
// kept one — that round trip is the whole point of this module.
const round = fakeStorage()
storeAccessToken(ENDPOINT, TOKEN, round.storage)
assert.equal(readStoredAccessToken(ENDPOINT, round.storage), TOKEN)
assert.ok(round.entries.has(STORAGE_KEY), 'token was not written to storage')

// The token belongs to one endpoint. Switching applications must never
// authenticate the new one with the old one's credential.
assert.equal(readStoredAccessToken(OTHER_ENDPOINT, round.storage), '')
storeAccessToken(OTHER_ENDPOINT, 'other-token', round.storage)
assert.equal(readStoredAccessToken(OTHER_ENDPOINT, round.storage), 'other-token')
assert.equal(
  readStoredAccessToken(ENDPOINT, round.storage),
  '',
  'the superseded endpoint kept a live credential'
)

// A rejected token is dropped rather than replayed on every reload.
forgetAccessToken(OTHER_ENDPOINT, round.storage)
assert.equal(readStoredAccessToken(OTHER_ENDPOINT, round.storage), '')
assert.equal(round.entries.size, 0, 'storage still holds a dropped token')

// Forgetting some other endpoint must not drop the one in use.
storeAccessToken(ENDPOINT, TOKEN, round.storage)
forgetAccessToken(OTHER_ENDPOINT, round.storage)
assert.equal(readStoredAccessToken(ENDPOINT, round.storage), TOKEN)

// Storing an empty token is a removal, not an empty credential.
storeAccessToken(ENDPOINT, '', round.storage)
assert.equal(readStoredAccessToken(ENDPOINT, round.storage), '')

// A reload is a fresh module with only storage to go on: reading has to work
// from the serialized record alone, not from anything held in memory.
const restored = fakeStorage({
  [STORAGE_KEY]: JSON.stringify({ endpointUrl: OTHER_ENDPOINT, token: TOKEN })
})
assert.equal(readStoredAccessToken(OTHER_ENDPOINT, restored.storage), TOKEN)
assert.equal(readStoredAccessToken(ENDPOINT, restored.storage), '')

// Corrupt or foreign contents are ignored rather than thrown over.
for (const contents of [
  'not json',
  '["array"]',
  JSON.stringify({ endpointUrl: OTHER_ENDPOINT }),
  JSON.stringify({ endpointUrl: OTHER_ENDPOINT, token: 42 })
]) {
  assert.equal(
    readStoredAccessToken(OTHER_ENDPOINT, fakeStorage({ [STORAGE_KEY]: contents }).storage),
    '',
    `accepted corrupt contents: ${contents}`
  )
}

// A storage that throws — Safari's private mode does — degrades to no cache
// instead of taking the page down with it. The token still has to reach the
// current session, or the bootstrap link itself would stop working.
const hostile: AccessTokenStorage = {
  getItem: () => {
    throw new Error('denied')
  },
  setItem: () => {
    throw new Error('denied')
  },
  removeItem: () => {
    throw new Error('denied')
  }
}
storeAccessToken(ENDPOINT, TOKEN, hostile)
assert.equal(
  readStoredAccessToken(ENDPOINT, hostile),
  TOKEN,
  'a blocked storage must not cost the current session its token'
)
forgetAccessToken(ENDPOINT, hostile)
assert.equal(readStoredAccessToken(ENDPOINT, hostile), '')

// No storage at all — server rendering — is a normal outcome.
storeAccessToken(ENDPOINT, TOKEN, undefined)
assert.equal(readStoredAccessToken(ENDPOINT, undefined), TOKEN)
forgetAccessToken(ENDPOINT, undefined)
assert.equal(readStoredAccessToken('', round.storage), '')

// Node has no sessionStorage unless web storage is enabled, which is exactly
// the "nothing durable to cache in" branch the callers have to tolerate.
assert.equal(sessionAccessTokenStorage(), undefined)

console.log('inspector-access-token-storage.test.ts ok')
