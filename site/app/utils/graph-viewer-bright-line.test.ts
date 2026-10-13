import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  BRIGHT_LINE_LARGE_GRAPH_MODULE_COUNT,
  BRIGHT_LINE_LARGE_GRAPH_WARNING,
  brightLineGraphKey,
  countGraphModules,
  isLargeBrightLineGraph,
  readBrightLineChoice,
  resolveShowBrightLine,
  shouldWarnAboutBrightLine,
  writeBrightLineChoice,
  type BrightLineStorage
} from './graph-viewer-bright-line.ts'

const STORAGE_KEY_PREFIX = 'nest-graph-inspector:bright-line:'
const TOKEN = 'ngi1.eyJpYXQiOjEsImV4cCI6Mn0.s1gn-atur_e'

function fakeStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial))

  return {
    entries,
    storage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value)
      }
    } satisfies BrightLineStorage
  }
}

/** A graph with `count` modules, which is all the default reads of it. */
function graphWithModules(count: number) {
  const modules: Record<string, object> = {}
  for (let index = 0; index < count; index += 1) {
    modules[`Module${index}`] = {}
  }

  return { modules }
}

/**
 * Whether the navigator shows Bright Line for a graph: what the tab kept for
 * it, else its size — the same two reads the store makes.
 */
function showBrightLineFor(
  endpointUrl: string,
  moduleCount: number,
  storage: BrightLineStorage
): boolean {
  return resolveShowBrightLine({
    moduleCount,
    choice: readBrightLineChoice(endpointUrl, storage)
  })
}

describe('the default, by graph size', () => {
  test('a large graph is one with ten modules or more', () => {
    assert.equal(BRIGHT_LINE_LARGE_GRAPH_MODULE_COUNT, 10)
    assert.equal(isLargeBrightLineGraph(9), false)
    assert.equal(isLargeBrightLineGraph(10), true)
    assert.equal(isLargeBrightLineGraph(11), true)
  })

  test('on below ten modules, off at ten and above', () => {
    assert.equal(resolveShowBrightLine({ moduleCount: 0, choice: null }), true)
    assert.equal(resolveShowBrightLine({ moduleCount: 9, choice: null }), true)
    assert.equal(resolveShowBrightLine({ moduleCount: 10, choice: null }), false)
    assert.equal(resolveShowBrightLine({ moduleCount: 11, choice: null }), false)
  })

  test('modules are counted as GraphOutput.modules lists them', () => {
    for (const count of [0, 9, 10, 11]) {
      assert.equal(countGraphModules(graphWithModules(count)), count)
    }
  })

  test('no graph yet counts as none', () => {
    assert.equal(countGraphModules(null), 0)
    assert.equal(countGraphModules(undefined), 0)
  })
})

describe('a manual choice', () => {
  test('outranks the default either way, on both sides of the boundary', () => {
    for (const moduleCount of [9, 10, 11]) {
      assert.equal(resolveShowBrightLine({ moduleCount, choice: true }), true)
      assert.equal(resolveShowBrightLine({ moduleCount, choice: false }), false)
    }
  })
})

describe('the large-graph warning', () => {
  test('says exactly what Bright Line may cost', () => {
    assert.equal(
      BRIGHT_LINE_LARGE_GRAPH_WARNING,
      'Bright Line mungkin memperlambat tampilan pada graph besar.'
    )
  })

  test('shows while Bright Line is on for ten modules or more', () => {
    assert.equal(shouldWarnAboutBrightLine({ moduleCount: 9, isOn: true }), false)
    assert.equal(shouldWarnAboutBrightLine({ moduleCount: 10, isOn: true }), true)
    assert.equal(shouldWarnAboutBrightLine({ moduleCount: 11, isOn: true }), true)
  })

  test('is hidden while Bright Line is off', () => {
    for (const moduleCount of [9, 10, 11]) {
      assert.equal(shouldWarnAboutBrightLine({ moduleCount, isOn: false }), false)
    }
  })

  // A large graph starts off, so the warning only ever answers the visitor
  // turning Bright Line on.
  test('never shows for a large graph left on its default', () => {
    for (const moduleCount of [10, 11]) {
      const isOn = resolveShowBrightLine({ moduleCount, choice: null })
      assert.equal(shouldWarnAboutBrightLine({ moduleCount, isOn }), false)
    }
  })
})

describe('the key a choice is kept under', () => {
  test('is the endpoint origin and path', () => {
    assert.equal(
      brightLineGraphKey('http://localhost:53371/__graph-inspector'),
      'http://localhost:53371/__graph-inspector'
    )
    assert.equal(
      brightLineGraphKey('http://localhost:53371/__graph-inspector/'),
      'http://localhost:53371/__graph-inspector'
    )
  })

  test('carries no credential: token, user info and fragment are dropped', () => {
    const key = brightLineGraphKey(
      `http://dev:hunter2@localhost:53371/__graph-inspector?__inspector_token=${TOKEN}#${TOKEN}`
    )

    assert.equal(key, 'http://localhost:53371/__graph-inspector')
    assert.ok(!key.includes(TOKEN), 'the access token reached the key')
    assert.ok(!key.includes('hunter2'), 'the password reached the key')
  })

  test('is empty for anything that is not an http(s) URL', () => {
    for (const endpointUrl of ['', 'localhost:53371', 'not a url', 'file:///tmp/graph']) {
      assert.equal(brightLineGraphKey(endpointUrl), '', endpointUrl)
    }
  })
})

// Each case uses endpoints of its own: what the module keeps in memory lasts as
// long as the module does, exactly as it lasts as long as the page.
describe('the choice a tab keeps', () => {
  test('is stored as on or off under the credential-free key', () => {
    const tab = fakeStorage()
    const endpoint = 'http://written.test:53371/__graph-inspector'

    writeBrightLineChoice(`${endpoint}?__inspector_token=${TOKEN}`, true, tab.storage)
    assert.deepEqual([...tab.entries], [[`${STORAGE_KEY_PREFIX}${endpoint}`, 'on']])

    writeBrightLineChoice(endpoint, false, tab.storage)
    assert.deepEqual([...tab.entries], [[`${STORAGE_KEY_PREFIX}${endpoint}`, 'off']])
    assert.ok(
      [...tab.entries].flat().every(text => !text.includes(TOKEN)),
      'the access token reached storage'
    )
  })

  test('a graph refresh keeps it, on either side of the boundary', () => {
    const tab = fakeStorage()
    const endpoint = 'http://refreshed.test/__graph-inspector'

    // Eleven modules start off; the visitor turns Bright Line on, and is warned.
    assert.equal(showBrightLineFor(endpoint, 11, tab.storage), false)
    writeBrightLineChoice(endpoint, true, tab.storage)
    assert.equal(showBrightLineFor(endpoint, 11, tab.storage), true)

    // Refreshed, the graph has shrunk to nine modules, then grown to twelve.
    assert.equal(showBrightLineFor(endpoint, 9, tab.storage), true)
    assert.equal(showBrightLineFor(endpoint, 12, tab.storage), true)
    assert.equal(shouldWarnAboutBrightLine({ moduleCount: 12, isOn: true }), true)
  })

  test('without one, a refreshed graph follows its new size', () => {
    const tab = fakeStorage()
    const endpoint = 'http://growing.test/__graph-inspector'

    assert.equal(showBrightLineFor(endpoint, 9, tab.storage), true)
    assert.equal(showBrightLineFor(endpoint, 10, tab.storage), false)
  })

  // A reload starts the page over: nothing held in memory survives, only what
  // the tab's storage kept — the entries the first case shows a write leaves.
  test('a reload finds it in the tab storage alone', () => {
    const reloadedOn = 'http://reloaded-on.test/__graph-inspector'
    const reloadedOff = 'http://reloaded-off.test/__graph-inspector'
    const tab = fakeStorage({
      [`${STORAGE_KEY_PREFIX}${reloadedOn}`]: 'on',
      [`${STORAGE_KEY_PREFIX}${reloadedOff}`]: 'off'
    })

    assert.equal(showBrightLineFor(reloadedOn, 11, tab.storage), true)
    assert.equal(showBrightLineFor(reloadedOff, 9, tab.storage), false)
  })

  test('switching graphs applies each graph its own default or saved choice', () => {
    const tab = fakeStorage()
    const largeGraph = 'http://large.test/__graph-inspector'
    const otherLargeGraph = 'http://other-large.test/__graph-inspector'
    const smallGraph = 'http://small.test/__graph-inspector'

    // The visitor turns Bright Line on for one large graph...
    assert.equal(showBrightLineFor(largeGraph, 11, tab.storage), false)
    writeBrightLineChoice(largeGraph, true, tab.storage)

    // ...which says nothing about the next: each starts from its own size.
    assert.equal(showBrightLineFor(otherLargeGraph, 11, tab.storage), false)
    assert.equal(showBrightLineFor(smallGraph, 9, tab.storage), true)
    writeBrightLineChoice(smallGraph, false, tab.storage)

    // Coming back, each graph finds its own choice again.
    assert.equal(showBrightLineFor(largeGraph, 11, tab.storage), true)
    assert.equal(showBrightLineFor(smallGraph, 9, tab.storage), false)
    assert.equal(showBrightLineFor(otherLargeGraph, 11, tab.storage), false)
  })

  test('the same graph reached with a fresh token keeps its choice', () => {
    const tab = fakeStorage()
    const endpoint = 'http://retoken.test/__graph-inspector'

    writeBrightLineChoice(`${endpoint}?__inspector_token=first`, true, tab.storage)
    assert.equal(
      readBrightLineChoice(`${endpoint}?__inspector_token=second`, tab.storage),
      true
    )
  })

  test('anything but on or off is ignored rather than trusted', () => {
    const endpoint = 'http://corrupt.test/__graph-inspector'

    for (const value of ['true', 'ON', '1', '', 'null']) {
      const tab = fakeStorage({ [`${STORAGE_KEY_PREFIX}${endpoint}`]: value })
      assert.equal(
        readBrightLineChoice(endpoint, tab.storage),
        null,
        `accepted ${JSON.stringify(value)}`
      )
    }
  })

  // Safari's private mode used to throw on any storage access.
  test('a storage that throws costs persistence, not the page', () => {
    const hostile: BrightLineStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      }
    }
    const endpoint = 'http://private.test/__graph-inspector'

    assert.equal(readBrightLineChoice(endpoint, hostile), null)
    writeBrightLineChoice(endpoint, true, hostile)
    assert.equal(
      readBrightLineChoice(endpoint, hostile),
      true,
      'the in-memory copy still serves this page'
    )
  })

  test('without any storage, as in server rendering, it stays in memory', () => {
    const endpoint = 'http://no-storage.test/__graph-inspector'

    assert.equal(readBrightLineChoice(endpoint, undefined), null)
    writeBrightLineChoice(endpoint, false, undefined)
    assert.equal(readBrightLineChoice(endpoint, undefined), false)
  })

  test('an endpoint with no key is kept for nobody', () => {
    const tab = fakeStorage()

    writeBrightLineChoice('', true, tab.storage)
    writeBrightLineChoice('not a url', true, tab.storage)

    assert.equal(tab.entries.size, 0)
    assert.equal(readBrightLineChoice('', tab.storage), null)
    assert.equal(readBrightLineChoice('not a url', tab.storage), null)
  })
})
