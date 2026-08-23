import { strict as assert } from 'node:assert'
import {
  clearGraphSession,
  readGraphSession,
  sessionGraphStorage,
  writeGraphSession,
  type GraphSessionStorage
} from './inspector-graph-session.ts'

const STORAGE_KEY = 'nest-graph-inspector:session'

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
    } satisfies GraphSessionStorage
  }
}

const ENDPOINT = 'http://0.0.0.0:53371/__graph-inspector'
const OTHER_ENDPOINT = 'http://0.0.0.0:4000/__graph-inspector'
const TOKEN = 'ngi1.eyJpYXQiOjEsImV4cCI6Mn0.s1gn-atur_e'

// The URL no longer says which graph the tab is on, so a reload has nothing to
// go on but this. That round trip is the whole point of the module.
const round = fakeStorage()
writeGraphSession({ endpointUrl: ENDPOINT, token: TOKEN }, round.storage)
assert.deepEqual(readGraphSession(round.storage), {
  endpointUrl: ENDPOINT,
  token: TOKEN
})
assert.ok(round.entries.has(STORAGE_KEY), 'session was not written to storage')

// One graph at a time: opening another replaces it rather than accumulating
// live credentials behind a well-known key.
writeGraphSession({ endpointUrl: OTHER_ENDPOINT, token: 'other' }, round.storage)
assert.deepEqual(readGraphSession(round.storage), {
  endpointUrl: OTHER_ENDPOINT,
  token: 'other'
})
assert.equal(round.entries.size, 1)

// A graph that needs no credential is still a session — the demo fixture is one.
writeGraphSession({ endpointUrl: ENDPOINT, token: '' }, round.storage)
assert.deepEqual(readGraphSession(round.storage), {
  endpointUrl: ENDPOINT,
  token: ''
})

// An endpoint is what makes a session; without one there is nothing to record.
writeGraphSession({ endpointUrl: '', token: TOKEN }, round.storage)
assert.equal(readGraphSession(round.storage)?.endpointUrl, ENDPOINT)

// Leaving the viewer forgets the graph, so `/view` starts clean.
clearGraphSession(round.storage)
assert.equal(readGraphSession(round.storage), undefined)
assert.equal(round.entries.size, 0, 'storage still holds a cleared session')

// A reload is a fresh module with only storage to go on: reading has to work
// from the serialized record alone, not from anything held in memory.
const restored = fakeStorage({
  [STORAGE_KEY]: JSON.stringify({ endpointUrl: OTHER_ENDPOINT, token: TOKEN })
})
assert.deepEqual(readGraphSession(restored.storage), {
  endpointUrl: OTHER_ENDPOINT,
  token: TOKEN
})

// Corrupt or foreign contents are ignored rather than thrown over.
for (const contents of [
  'not json',
  '["array"]',
  'null',
  JSON.stringify({ endpointUrl: OTHER_ENDPOINT }),
  JSON.stringify({ endpointUrl: OTHER_ENDPOINT, token: 42 }),
  JSON.stringify({ endpointUrl: '', token: TOKEN }),
  JSON.stringify({ token: TOKEN })
]) {
  clearGraphSession(fakeStorage().storage)
  assert.equal(
    readGraphSession(fakeStorage({ [STORAGE_KEY]: contents }).storage),
    undefined,
    `accepted corrupt contents: ${contents}`
  )
}

// A storage that throws — Safari's private mode does — degrades to memory only
// instead of taking the page down. The session still has to reach the current
// page, or the printed link itself would stop working.
const hostile: GraphSessionStorage = {
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
writeGraphSession({ endpointUrl: ENDPOINT, token: TOKEN }, hostile)
assert.deepEqual(
  readGraphSession(hostile),
  { endpointUrl: ENDPOINT, token: TOKEN },
  'a blocked storage must not cost the current page its graph'
)
clearGraphSession(hostile)
assert.equal(readGraphSession(hostile), undefined)

// No storage at all — server rendering — is a normal outcome.
writeGraphSession({ endpointUrl: ENDPOINT, token: TOKEN }, undefined)
assert.deepEqual(readGraphSession(undefined), {
  endpointUrl: ENDPOINT,
  token: TOKEN
})
clearGraphSession(undefined)

// Node has no sessionStorage unless web storage is enabled, which is exactly
// the "nothing durable to keep this in" branch the callers have to tolerate.
assert.equal(sessionGraphStorage(), undefined)

console.log('inspector-graph-session.test.ts ok')
