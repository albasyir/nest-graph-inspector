import { strict as assert } from 'node:assert'
import type { GraphLayout } from 'nest-graph-inspector'
import {
  GRAPH_LAYOUT_FILE_NAME,
  isGraphLayout,
  readLayoutResponseError,
  readStoredLayout,
  serializeGraphLayout,
  writeStoredLayout,
  type GraphLayoutStorage
} from './graph-layout-persistence.ts'

function fakeStorage(): GraphLayoutStorage & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    }
  }
}

const layout: GraphLayout = {
  version: '1',
  modules: {
    UserModule: {
      position: { x: 120, y: 40 },
      isCollapsed: true,
      items: { 'provider-UserModule-UserService': { x: 20, y: 56 } }
    }
  }
}

// A downloaded layout is byte-for-byte what the library would have written.
assert.equal(GRAPH_LAYOUT_FILE_NAME, 'nest-graph-layout.json')
assert.equal(
  serializeGraphLayout(layout),
  `${JSON.stringify(layout, null, 2)}\n`
)
assert.ok(serializeGraphLayout(layout).startsWith('{\n  "version": "1"'))

// The shape check accepts what the library serves and refuses what it never would.
assert.ok(isGraphLayout(layout))
assert.ok(isGraphLayout({ version: '1', modules: {} }))
for (const notALayout of [
  null,
  [],
  'layout',
  { version: '2', modules: {} },
  { version: '1' },
  { version: '1', modules: [] },
  { version: '1', modules: { A: {} } },
  { version: '1', modules: { A: { position: { x: '1', y: 0 } } } },
  { version: '1', modules: { A: { position: { x: Infinity, y: 0 } } } },
  { version: '1', modules: { A: { position: { x: 0, y: 0 }, isCollapsed: 1 } } },
  { version: '1', modules: { A: { position: { x: 0, y: 0 }, items: [] } } },
  {
    version: '1',
    modules: { A: { position: { x: 0, y: 0 }, items: { b: { x: 0 } } } }
  }
]) {
  assert.equal(
    isGraphLayout(notALayout),
    false,
    `${JSON.stringify(notALayout)} should not count as a layout`
  )
}

// The tab keeps a layout per endpoint and hands it back after a reload, when
// only session storage survives.
{
  const storage = fakeStorage()
  const endpoint = 'http://localhost:53371/__graph-inspector'

  assert.equal(readStoredLayout(endpoint, storage), null)
  writeStoredLayout(endpoint, layout, storage)
  assert.deepEqual(readStoredLayout(endpoint, storage), layout)
  assert.deepEqual(
    JSON.parse(storage.items.get(`nest-graph-inspector:layout:${endpoint}`)!),
    layout
  )
  assert.equal(
    readStoredLayout('http://localhost:53372/graph', storage),
    null,
    'a layout belongs to the endpoint it was saved for'
  )
}

// A session written before a reload is read back without the in-memory copy.
{
  const storage = fakeStorage()
  const endpoint = 'http://reloaded.test/graph'
  storage.setItem(
    `nest-graph-inspector:layout:${endpoint}`,
    JSON.stringify(layout)
  )

  assert.deepEqual(readStoredLayout(endpoint, storage), layout)
}

// Whatever a session holds that is not a layout is ignored, not trusted.
{
  const storage = fakeStorage()
  storage.setItem('nest-graph-inspector:layout:http://broken.test', '{not json')
  storage.setItem(
    'nest-graph-inspector:layout:http://wrong.test',
    JSON.stringify({ version: '9', modules: {} })
  )

  assert.equal(readStoredLayout('http://broken.test', storage), null)
  assert.equal(readStoredLayout('http://wrong.test', storage), null)
  assert.equal(readStoredLayout('', storage), null)
}

// Storage that throws — Safari's private mode — costs persistence, not the page.
{
  const throwing: GraphLayoutStorage = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    }
  }
  const endpoint = 'http://private.test/graph'

  assert.equal(readStoredLayout(endpoint, throwing), null)
  writeStoredLayout(endpoint, layout, throwing)
  assert.deepEqual(
    readStoredLayout(endpoint, throwing),
    layout,
    'the in-memory copy still serves this page'
  )
  assert.equal(readStoredLayout('http://no-storage.test', undefined), null)
}

// A rejected save reports what the inspector said, reasons included.
assert.equal(
  readLayoutResponseError({
    statusCode: 400,
    data: {
      ok: false,
      message: 'Invalid layout payload',
      errors: ['layout/version must be "1"', 'layout/modules must be an object']
    }
  }),
  'Invalid layout payload: layout/version must be "1"; layout/modules must be an object'
)
assert.equal(
  readLayoutResponseError({ data: { ok: false, message: 'Request body is too large.' } }),
  'Request body is too large.'
)
for (const unhelpful of [undefined, null, 'boom', {}, { data: { error: 'x' } }]) {
  assert.equal(readLayoutResponseError(unhelpful), '')
}

console.log('graph-layout-persistence.test.ts ok')
