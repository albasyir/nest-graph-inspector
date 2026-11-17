import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  initialModuleLayoutStatus,
  isModuleLayoutPending,
  moduleLayoutFailureText,
  moduleLayoutProgressText,
  nextModuleLayoutStatus,
  type ModuleLayoutEvent,
  type ModuleLayoutStatus
} from './module-layout-state.ts'

/** The status after each event in turn, from a viewer with no saved arrangement. */
function after(
  events: readonly ModuleLayoutEvent[],
  from: ModuleLayoutStatus = initialModuleLayoutStatus({ hasArrangement: false })
): ModuleLayoutStatus {
  return events.reduce(nextModuleLayoutStatus, from)
}

describe('a viewer\'s first layout', () => {
  test('starts loading ELK with the canvas held back, when there is no saved arrangement', () => {
    assert.deepEqual(
      initialModuleLayoutStatus({ hasArrangement: false }),
      { state: 'loading-engine', isCanvasShown: false }
    )
  })

  test('is ready at once, canvas shown, with a saved arrangement', () => {
    assert.deepEqual(
      initialModuleLayoutStatus({ hasArrangement: true }),
      { state: 'ready', isCanvasShown: true }
    )
  })

  test('goes from loading ELK to arranging to ready, the canvas shown only then', () => {
    const asked = after([{ type: 'requested', isEngineReady: false }])
    const up = nextModuleLayoutStatus(asked, { type: 'engine-ready' })
    const drawn = nextModuleLayoutStatus(up, { type: 'laid-out' })

    assert.deepEqual(asked, { state: 'loading-engine', isCanvasShown: false })
    assert.deepEqual(up, { state: 'arranging', isCanvasShown: false })
    assert.deepEqual(drawn, { state: 'ready', isCanvasShown: true })
  })

  test('arranges straight away when ELK is warm already', () => {
    assert.deepEqual(
      after([{ type: 'requested', isEngineReady: true }]),
      { state: 'arranging', isCanvasShown: false }
    )
  })

  test('fails, showing the simple arrangement, when ELK does', () => {
    for (const failure of ['engine', 'layout'] as const) {
      assert.deepEqual(
        after([{ type: 'requested', isEngineReady: false }, { type: 'fell-back', failure }]),
        { state: 'failed', isCanvasShown: true, failure }
      )
    }
  })

  test('is ready, canvas shown, when a saved arrangement takes over before ELK lands', () => {
    assert.deepEqual(
      after([{ type: 'requested', isEngineReady: false }, { type: 'arrangement-drawn' }]),
      { state: 'ready', isCanvasShown: true }
    )
  })
})

describe('a later layout', () => {
  const ready = after([{ type: 'requested', isEngineReady: true }, { type: 'laid-out' }])

  test('keeps the drawing on screen while it arranges, and is ready once it lands', () => {
    const asked = nextModuleLayoutStatus(ready, { type: 'requested', isEngineReady: true })

    assert.deepEqual(asked, { state: 'arranging', isCanvasShown: true })
    assert.deepEqual(nextModuleLayoutStatus(asked, { type: 'laid-out' }), ready)
  })

  test('says it is loading ELK again when the engine has to start afresh', () => {
    assert.deepEqual(
      nextModuleLayoutStatus(ready, { type: 'requested', isEngineReady: false }),
      { state: 'loading-engine', isCanvasShown: true }
    )
  })
})

describe('trying again after a failure', () => {
  const failed = after([{ type: 'requested', isEngineReady: false }, { type: 'fell-back', failure: 'engine' }])

  test('goes back through loading ELK and arranging to ready, the failure gone', () => {
    const steps: readonly ModuleLayoutEvent[] = [
      { type: 'requested', isEngineReady: false },
      { type: 'engine-ready' },
      { type: 'laid-out' }
    ]
    const states = steps.reduce<ModuleLayoutStatus[]>(
      (seen, event) => [...seen, nextModuleLayoutStatus(seen.at(-1) ?? failed, event)],
      []
    )

    assert.deepEqual(states, [
      { state: 'loading-engine', isCanvasShown: true },
      { state: 'arranging', isCanvasShown: true },
      { state: 'ready', isCanvasShown: true }
    ])
  })

  test('fails again, with the new reason, when ELK fails again', () => {
    assert.deepEqual(
      after([{ type: 'requested', isEngineReady: true }, { type: 'fell-back', failure: 'layout' }], failed),
      { state: 'failed', isCanvasShown: true, failure: 'layout' }
    )
  })
})

describe('ELK coming up', () => {
  test('changes nothing heard late, once the layout has landed or failed', () => {
    const ready = after([{ type: 'requested', isEngineReady: false }, { type: 'laid-out' }])
    const failed = after([{ type: 'requested', isEngineReady: false }, { type: 'fell-back', failure: 'engine' }])

    assert.equal(nextModuleLayoutStatus(ready, { type: 'engine-ready' }), ready)
    assert.equal(nextModuleLayoutStatus(failed, { type: 'engine-ready' }), failed)
  })
})

describe('what the viewer says', () => {
  test('is busy only while a layout is still to land', () => {
    assert.equal(isModuleLayoutPending({ state: 'loading-engine', isCanvasShown: false }), true)
    assert.equal(isModuleLayoutPending({ state: 'arranging', isCanvasShown: true }), true)
    assert.equal(isModuleLayoutPending({ state: 'ready', isCanvasShown: true }), false)
    assert.equal(isModuleLayoutPending({ state: 'failed', isCanvasShown: true, failure: 'engine' }), false)
  })

  test('says which phase a layout is in, and nothing once it has landed', () => {
    assert.equal(moduleLayoutProgressText({ state: 'loading-engine', isCanvasShown: false }), 'Loading layout engine…')
    assert.equal(moduleLayoutProgressText({ state: 'arranging', isCanvasShown: false }), 'Arranging graph…')
    assert.equal(moduleLayoutProgressText({ state: 'ready', isCanvasShown: true }), undefined)
    assert.equal(moduleLayoutProgressText({ state: 'failed', isCanvasShown: true, failure: 'layout' }), undefined)
  })

  test('says what failed, and that a simple arrangement is shown instead', () => {
    assert.equal(
      moduleLayoutFailureText('engine'),
      'Couldn’t load the layout engine. Showing a simple arrangement.'
    )
    assert.equal(
      moduleLayoutFailureText('layout'),
      'Couldn’t arrange this graph. Showing a simple arrangement.'
    )
  })
})
