import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import type { GraphLayout, GraphOutput } from 'nest-graph-inspector'
import { readStoredLayout, writeStoredLayout } from './graph-layout-persistence.ts'
import {
  MAX_STORED_GRAPH_CHARS,
  clearGraphFileSession,
  describeGraphFileDirectRun,
  graphFileKey,
  readGraphFileSession,
  writeGraphFileSession,
  type GraphFileStorage
} from './graph-file-session.ts'

const KEY = 'nest-graph-inspector:graph-file'

/** A `sessionStorage` stand-in that can be told to refuse writes, as a full one does. */
function memoryStorage(options: { quota?: number } = {}) {
  const items = new Map<string, string>()
  const storage: GraphFileStorage = {
    getItem: key => items.get(key) ?? null,
    setItem: (key, value) => {
      if (options.quota !== undefined && value.length > options.quota) {
        throw new Error('QuotaExceededError')
      }
      items.set(key, value)
    },
    removeItem: (key) => {
      items.delete(key)
    }
  }

  return { storage, items }
}

const graph = {
  version: '3',
  root: 'AppModule',
  modules: {
    AppModule: { imports: [], exports: [], providers: [], controllers: [] }
  },
  cycles: { modules: [], providers: [], controllers: [] }
} as unknown as GraphOutput

describe('a graph file kept for the tab', () => {
  test('comes back whole after a reload', () => {
    const { storage } = memoryStorage()

    assert.equal(writeGraphFileSession({ name: 'app.json', kind: 'file' }, graph, storage), true)
    assert.deepEqual(readGraphFileSession(storage), {
      source: { name: 'app.json', kind: 'file' },
      graphText: JSON.stringify(graph)
    })
  })

  test('keeps the notice it opened with', () => {
    const { storage } = memoryStorage()
    const source = { name: 'next.json', kind: 'file' as const, notice: 'Newer format.' }

    writeGraphFileSession(source, graph, storage)

    assert.deepEqual(readGraphFileSession(storage)?.source, source)
  })

  // Too large to keep: a reload says which file to open again rather than
  // showing nothing, and the tab's other sessions keep their room.
  test('too large to keep leaves only its name', () => {
    const { storage, items } = memoryStorage()
    const large = {
      ...graph,
      modules: { AppModule: { imports: [], exports: [], providers: [], controllers: [], jsdoc: 'x'.repeat(MAX_STORED_GRAPH_CHARS) } }
    } as unknown as GraphOutput

    assert.equal(writeGraphFileSession({ name: 'big.json', kind: 'file' }, large, storage), false)
    assert.deepEqual(readGraphFileSession(storage), { source: { name: 'big.json', kind: 'file' } })
    assert.ok((items.get(KEY)?.length ?? 0) < 100)
  })

  test('that storage refuses leaves only its name, or nothing', () => {
    const tight = memoryStorage({ quota: 80 })

    assert.equal(writeGraphFileSession({ name: 'app.json', kind: 'file' }, graph, tight.storage), false)
    assert.deepEqual(readGraphFileSession(tight.storage), { source: { name: 'app.json', kind: 'file' } })

    const full = memoryStorage({ quota: 0 })
    assert.equal(writeGraphFileSession({ name: 'app.json', kind: 'file' }, graph, full.storage), false)
    assert.equal(readGraphFileSession(full.storage), undefined)
  })

  // Even the name-only record refused: the file before must not be left to
  // come back on a reload in place of this one.
  test('that storage refuses entirely leaves no other file behind', () => {
    const { storage, items } = memoryStorage({ quota: 0 })
    items.set(KEY, JSON.stringify({ name: 'earlier.json', kind: 'file', graph: JSON.stringify(graph) }))

    assert.equal(writeGraphFileSession({ name: 'later.json', kind: 'file' }, graph, storage), false)
    assert.equal(readGraphFileSession(storage), undefined)
  })

  test('is nothing without storage, or once cleared', () => {
    assert.equal(writeGraphFileSession({ name: 'app.json', kind: 'file' }, graph, undefined), false)
    assert.equal(readGraphFileSession(undefined), undefined)

    const { storage } = memoryStorage()
    writeGraphFileSession({ name: 'app.json', kind: 'file' }, graph, storage)
    clearGraphFileSession(storage)

    assert.equal(readGraphFileSession(storage), undefined)
  })

  test('that was tampered with is ignored', () => {
    for (const raw of ['not json', '[]', '{}', '{"name":"","kind":"file"}', '{"name":"a.json","kind":"url"}', '{"name":3,"kind":"file"}']) {
      const { storage, items } = memoryStorage()
      items.set(KEY, raw)

      assert.equal(readGraphFileSession(storage), undefined, raw)
    }
  })

  test('that storage throws on is ignored', () => {
    const throwing: GraphFileStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      }
    }

    assert.equal(readGraphFileSession(throwing), undefined)
    assert.equal(writeGraphFileSession({ name: 'app.json', kind: 'file' }, graph, throwing), false)
    assert.doesNotThrow(() => clearGraphFileSession(throwing))
  })
})

describe('what a graph file is kept under', () => {
  const text = JSON.stringify(graph)

  test('tells a file from the example, and one file from another', () => {
    assert.match(graphFileKey({ name: 'graph.json', kind: 'example' }, text), /^example:graph\.json:/)
    assert.match(graphFileKey({ name: 'graph.json', kind: 'file' }, text), /^file:graph\.json:/)
    assert.notEqual(
      graphFileKey({ name: 'a.json', kind: 'file' }, text),
      graphFileKey({ name: 'b.json', kind: 'file' }, text)
    )
  })

  test('tells two graphs under one name apart', () => {
    const other = JSON.stringify({ ...graph, root: 'OtherModule' })

    assert.notEqual(
      graphFileKey({ name: 'graph.json', kind: 'file' }, text),
      graphFileKey({ name: 'graph.json', kind: 'file' }, other)
    )
  })
})

// The layout a graph file was arranged into belongs to that graph: another
// file with the same name, opened later in the tab, starts from its own
// layout, while the same graph, back after a reload, gets its arrangement back.
describe('a graph file\'s layout', () => {
  const LAYOUT_PREFIX = 'nest-graph-inspector:layout:'
  const layout: GraphLayout = { version: '1', modules: { AppModule: { position: { x: 120, y: 40 } } } }
  const source = { name: 'graph.json', kind: 'file' as const }

  test('is not handed to a different graph with the same name', () => {
    const { storage: layouts } = memoryStorage()
    writeStoredLayout(graphFileKey(source, JSON.stringify(graph)), layout, layouts)

    const other = { ...graph, root: 'BillingModule' } as unknown as GraphOutput
    const otherKey = graphFileKey(source, JSON.stringify(other))

    assert.equal(readStoredLayout(otherKey, layouts), null)
  })

  test('comes back with the same graph after a reload', () => {
    const { storage: layouts, items } = memoryStorage()
    const { storage: session } = memoryStorage()
    const openedKey = graphFileKey(source, JSON.stringify(graph))
    writeStoredLayout(openedKey, layout, layouts)
    writeGraphFileSession(source, graph, session)

    // A reload: the graph comes back from the tab as the text it was kept as.
    const restored = readGraphFileSession(session)
    assert.ok(restored?.graphText)
    const restoredKey = graphFileKey(restored.source, restored.graphText)

    assert.equal(restoredKey, openedKey)
    // Read from the tab's storage itself: a reload starts with nothing in
    // memory, so that is where the layout has to be found.
    assert.deepEqual(JSON.parse(items.get(LAYOUT_PREFIX + restoredKey) ?? 'null'), layout)
    assert.deepEqual(readStoredLayout(restoredKey, layouts), layout)
  })
})

describe('Direct Run on a graph file', () => {
  test('says what would run it, for a file and for the example', () => {
    assert.match(describeGraphFileDirectRun({ name: 'app.json', kind: 'file' }), /opened from a file/)
    assert.match(describeGraphFileDirectRun({ name: 'graph.json', kind: 'example' }), /Load Example/)
  })

  test('never names the file', () => {
    assert.ok(!describeGraphFileDirectRun({ name: 'secret-app.json', kind: 'file' }).includes('secret-app'))
  })
})
