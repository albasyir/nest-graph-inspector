import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import type { GraphOutputModule } from 'nest-graph-inspector'
import { DEFAULT_BRACKET_DEPTH } from './module-dependency-bracket.ts'
import {
  BLAST_DEMO_MODULE,
  describeBlastRadius,
  isBlastDemoAtStart,
  recenterBlastDemo,
  resolveBlastDemoCenter,
  setBlastDemoDepth,
  startBlastDemo
} from './landing-blast-demo.ts'

function module(imports: string[] = []): GraphOutputModule {
  return { imports, exports: [], providers: [], controllers: [] }
}

describe('the demo as it opens', () => {
  test('is CustomerModule, three levels each side', () => {
    assert.equal(BLAST_DEMO_MODULE, 'CustomerModule')
    assert.deepEqual(startBlastDemo(), {
      center: 'CustomerModule',
      depth: { left: DEFAULT_BRACKET_DEPTH, right: DEFAULT_BRACKET_DEPTH }
    })
    assert.equal(isBlastDemoAtStart(startBlastDemo()), true)
  })

  test('is a fresh state each time, never one an earlier visitor changed', () => {
    const first = startBlastDemo()
    first.depth.right = 9
    assert.equal(startBlastDemo().depth.right, DEFAULT_BRACKET_DEPTH)
  })
})

describe('what the visitor does', () => {
  test('re-centring puts another module in the middle and keeps both depths', () => {
    const deeper = setBlastDemoDepth(startBlastDemo(), 'right', 5)
    assert.deepEqual(recenterBlastDemo(deeper, 'AuthModule'), {
      center: 'AuthModule',
      depth: { left: DEFAULT_BRACKET_DEPTH, right: 5 }
    })
  })

  test('a depth changes its own side only', () => {
    const state = setBlastDemoDepth(startBlastDemo(), 'left', 1)
    assert.deepEqual(state.depth, { left: 1, right: DEFAULT_BRACKET_DEPTH })
  })

  test('never changes the state it was given', () => {
    const start = startBlastDemo()
    recenterBlastDemo(start, 'AuthModule')
    setBlastDemoDepth(start, 'right', 4)
    assert.deepEqual(start, startBlastDemo())
  })

  test('any move off the opening state offers a reset, and coming back withdraws it', () => {
    const start = startBlastDemo()
    assert.equal(isBlastDemoAtStart(recenterBlastDemo(start, 'AuthModule')), false)
    assert.equal(isBlastDemoAtStart(setBlastDemoDepth(start, 'left', 1)), false)
    assert.equal(isBlastDemoAtStart(setBlastDemoDepth(start, 'right', 4)), false)

    const back = recenterBlastDemo(recenterBlastDemo(start, 'AuthModule'), BLAST_DEMO_MODULE)
    assert.equal(isBlastDemoAtStart(back), true)
  })
})

describe('the module in the middle', () => {
  const graph = {
    root: 'AppModule',
    modules: {
      AppModule: module(['CustomerModule', 'AuthModule']),
      AuthModule: module(['CustomerModule']),
      CustomerModule: module()
    }
  }

  test('is the one asked for while the graph has it', () => {
    assert.equal(resolveBlastDemoCenter(graph, 'AuthModule'), 'AuthModule')
  })

  // The static graph has NestJSCoreModule; the live demo's graph does not.
  test('is the module the demo opens on when the graph lacks the one asked for', () => {
    assert.equal(resolveBlastDemoCenter(graph, 'NestJSCoreModule'), BLAST_DEMO_MODULE)
  })

  test('is the root of the graph when the graph lacks the opening module too', () => {
    const other = { root: 'AppModule', modules: { AppModule: module() } }
    assert.equal(resolveBlastDemoCenter(other, 'NestJSCoreModule'), 'AppModule')
  })

  test('is never a name the graph does not hold as a module', () => {
    assert.equal(resolveBlastDemoCenter(graph, 'toString'), BLAST_DEMO_MODULE)
    assert.equal(resolveBlastDemoCenter({ root: 'AppModule', modules: {} }, 'AppModule'), null)
  })
})

describe('the finding', () => {
  test('says how many modules a change reaches, and how far', () => {
    assert.deepEqual(describeBlastRadius({ modules: 9, levels: 5 }), {
      kind: 'reaches',
      modules: '9 modules',
      distance: 'up to 5 levels away'
    })
  })

  test('says a reach of one level is direct', () => {
    assert.deepEqual(describeBlastRadius({ modules: 1, levels: 1 }), {
      kind: 'reaches',
      modules: '1 module',
      distance: 'directly'
    })
    assert.deepEqual(describeBlastRadius({ modules: 11, levels: 1 }), {
      kind: 'reaches',
      modules: '11 modules',
      distance: 'all directly'
    })
  })

  test('says when nothing depends on the module', () => {
    assert.deepEqual(describeBlastRadius({ modules: 0, levels: 0 }), { kind: 'contained' })
  })
})
