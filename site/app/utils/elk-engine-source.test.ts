import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import type { ElkNode } from 'elkjs/lib/elk-api'
import {
  createSharedElkEngineSource,
  failureSignal,
  lazyElkEngineSource,
  type ElkEngineReadyTiming,
  type RunningElk
} from './elk-engine-source.ts'
import {
  ElkEngineFailure,
  type ElkEngineSource,
  type ElkRuntime
} from './module-graph-auto-layout.ts'

const WARM_UP_GRAPH: ElkNode = { id: 'warm-up' }
const GRAPH: ElkNode = { id: 'graph' }

/** Lets every callback already queued run. */
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** Whether a promise has settled, waiting only for what is already queued. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  promise.then(() => {
    settled = true
  }, () => {
    settled = true
  })
  await settle()
  return settled
}

/**
 * A stand-in ELK, as a worker would be: its layouts answer only when told to,
 * and it can die on its own.
 */
function standIn(runtime: ElkRuntime = 'worker') {
  const requested: ElkNode[] = []
  const unanswered: (() => void)[] = []
  const { failure, fail, guard } = failureSignal()
  const running: RunningElk = {
    engine: {
      runtime,
      layout: graph => guard(() => {
        requested.push(graph)
        return new Promise<ElkNode>((resolve) => {
          unanswered.push(() => resolve(graph))
        })
      })
    },
    failure
  }

  return {
    running,
    requested,
    answerAll: async () => {
      for (const answer of unanswered.splice(0)) {
        answer()
      }
      await settle()
    },
    die: () => fail(new Error('the worker\'s script did not load'))
  }
}

/** A source over stand-in workers, started one after another, counted. */
function sourceOver(workers: ReturnType<typeof standIn>[], extra: {
  onReady?: (timing: ElkEngineReadyTiming) => void
  now?: () => number
} = {}) {
  let starts = 0
  const engines = createSharedElkEngineSource({
    startWorker: () => workers[starts++]?.running,
    startOnThisThread: () => Promise.reject(new Error('there is always a worker here')),
    warmUpGraph: WARM_UP_GRAPH,
    ...extra
  })

  return { engines, starts: () => starts }
}

describe('warming up', () => {
  test('starts one engine, however often asked, and has it lay the warm-up graph out', async () => {
    const worker = standIn()
    const { engines, starts } = sourceOver([worker])

    engines.warmUp()
    engines.warmUp()
    await settle()

    assert.equal(starts(), 1)
    assert.deepEqual(worker.requested, [WARM_UP_GRAPH])
  })

  test('hands every warm-up run to ELK at once', async () => {
    const worker = standIn()
    const engines = createSharedElkEngineSource({
      startWorker: () => worker.running,
      startOnThisThread: () => Promise.reject(new Error('there is always a worker here')),
      warmUpGraph: WARM_UP_GRAPH,
      warmUpRuns: 3
    })

    engines.warmUp()
    await settle()

    assert.deepEqual(worker.requested, [WARM_UP_GRAPH, WARM_UP_GRAPH, WARM_UP_GRAPH])
  })

  test('is ready once the warm-up graph is laid out, and says how long that took', async () => {
    const worker = standIn()
    const timings: ElkEngineReadyTiming[] = []
    let clock = 100
    const { engines } = sourceOver([worker], {
      onReady: timing => timings.push(timing),
      now: () => clock
    })

    engines.warmUp()
    await settle()
    assert.equal(engines.isReady(), false)

    clock = 350
    await worker.answerAll()

    assert.equal(engines.isReady(), true)
    assert.deepEqual(timings, [{ start: 100, end: 350, runtime: 'worker' }])
  })

  test('shares the engine it warmed with every layout after', async () => {
    const worker = standIn()
    const { engines, starts } = sourceOver([worker])

    engines.warmUp()
    await settle()
    await worker.answerAll()
    const laidOut = (await engines.acquire()).layout(GRAPH)
    await worker.answerAll()

    assert.deepEqual(await laidOut, GRAPH)
    assert.equal(starts(), 1)
    assert.deepEqual(worker.requested, [WARM_UP_GRAPH, GRAPH])
  })
})

describe('a layout with nothing warmed', () => {
  test('starts ELK itself, lays out its own graph alone, and leaves it ready', async () => {
    const worker = standIn()
    const { engines, starts } = sourceOver([worker])

    const engine = await engines.acquire()
    assert.equal(engines.isReady(), false)
    const laidOut = engine.layout(GRAPH)
    await worker.answerAll()
    await laidOut

    assert.equal(starts(), 1)
    assert.deepEqual(worker.requested, [GRAPH])
    assert.equal(engines.isReady(), true)
  })
})

describe('saying when ELK is ready', () => {
  test('once the engine has finished its first layout — a warm-up\'s — and not before', async () => {
    const worker = standIn()
    const { engines } = sourceOver([worker])

    engines.warmUp()
    await settle()
    const ready = engines.whenReady()
    assert.equal(await hasSettled(ready), false)

    await worker.answerAll()

    assert.equal(await hasSettled(ready), true)
    await ready
  })

  test('at once for an engine already up', async () => {
    const worker = standIn()
    const { engines } = sourceOver([worker])

    engines.warmUp()
    await settle()
    await worker.answerAll()

    await engines.whenReady()
  })

  test('never, but failing, when the engine dies first', async () => {
    const worker = standIn()
    const { engines } = sourceOver([worker])

    const layout = (await engines.acquire()).layout(GRAPH)
    const ready = engines.whenReady()
    worker.die()

    await assert.rejects(ready, ElkEngineFailure)
    await assert.rejects(layout, ElkEngineFailure)
    assert.equal(engines.isReady(), false)
  })

  test('failing at once when no engine is running', async () => {
    const { engines, starts } = sourceOver([standIn()])

    await assert.rejects(engines.whenReady(), ElkEngineFailure)
    assert.equal(starts(), 0)
  })
})

describe('without a worker', () => {
  for (const [why, startWorker] of [
    ['when the browser has none', () => undefined],
    ['when making one throws', () => {
      throw new Error('SecurityError')
    }]
  ] as const) {
    test(`runs ELK on this thread ${why}`, async () => {
      const onThisThread = standIn('main-thread')
      const engines = createSharedElkEngineSource({
        startWorker,
        startOnThisThread: () => Promise.resolve(onThisThread.running),
        warmUpGraph: WARM_UP_GRAPH
      })

      const engine = await engines.acquire()
      const laidOut = engine.layout(GRAPH)
      await onThisThread.answerAll()

      assert.equal(engine.runtime, 'main-thread')
      assert.deepEqual(await laidOut, GRAPH)
    })
  }
})

describe('an engine that fails', () => {
  test('a worker that dies fails its layouts as an engine failure, and the next layout gets a fresh one', async () => {
    const workers = [standIn(), standIn()]
    const { engines, starts } = sourceOver(workers)

    const failed = (await engines.acquire()).layout(GRAPH)
    workers[0]?.die()

    await assert.rejects(failed, (error: unknown) =>
      error instanceof ElkEngineFailure && /did not load/.test(error.message)
    )
    await settle()
    const retried = (await engines.acquire()).layout(GRAPH)
    await workers[1]?.answerAll()

    assert.deepEqual(await retried, GRAPH)
    assert.equal(starts(), 2)
    assert.deepEqual(workers[1]?.requested, [GRAPH])
  })

  test('one that could not start is tried again by the next layout', async () => {
    let attempts = 0
    const onThisThread = standIn('main-thread')
    const engines = createSharedElkEngineSource({
      startWorker: () => undefined,
      startOnThisThread: () => {
        attempts += 1
        return attempts === 1
          ? Promise.reject(new Error('the chunk failed to load'))
          : Promise.resolve(onThisThread.running)
      },
      warmUpGraph: WARM_UP_GRAPH
    })

    await assert.rejects(engines.acquire(), /failed to load/)
    await settle()
    const engine = await engines.acquire()

    assert.equal(engine.runtime, 'main-thread')
    assert.equal(attempts, 2)
  })
})

describe('a source in a module of its own', () => {
  /** The source the module holds: warm or not, counting what it is asked. */
  function inner(isReady: boolean) {
    let acquired = 0
    let askedWhenReady = 0
    const source: ElkEngineSource = {
      isReady: () => isReady,
      acquire: () => {
        acquired += 1
        return Promise.resolve({ runtime: 'worker', layout: graph => Promise.resolve(graph) })
      },
      whenReady: () => {
        askedWhenReady += 1
        return Promise.resolve()
      }
    }

    return { source, acquired: () => acquired, askedWhenReady: () => askedWhenReady }
  }

  test('is not ready before its module is imported, and has no engine to wait on', async () => {
    let imports = 0
    const engines = lazyElkEngineSource(() => {
      imports += 1
      return Promise.resolve(inner(true).source)
    })

    assert.equal(engines.isReady(), false)
    await assert.rejects(engines.whenReady(), ElkEngineFailure)
    assert.equal(imports, 0)
  })

  test('once loaded, says what the source in it says, without starting ELK', async () => {
    const module = inner(true)
    let imports = 0
    const engines = lazyElkEngineSource(() => {
      imports += 1
      return Promise.resolve(module.source)
    })

    await engines.load()
    await engines.load()

    assert.equal(engines.isReady(), true)
    assert.equal(module.acquired(), 0)
    assert.equal(imports, 1)
    await engines.whenReady()
    assert.equal(module.askedWhenReady(), 1)
  })

  test('imports its module for the first layout, and once only', async () => {
    const module = inner(false)
    let imports = 0
    const engines = lazyElkEngineSource(() => {
      imports += 1
      return Promise.resolve(module.source)
    })

    await engines.acquire()
    await engines.acquire()

    assert.equal(imports, 1)
    assert.equal(module.acquired(), 2)
  })

  test('fails the layout whose import failed, and imports again for the next', async () => {
    const module = inner(false)
    let imports = 0
    const engines = lazyElkEngineSource(() => {
      imports += 1
      return imports === 1
        ? Promise.reject(new TypeError('Failed to fetch dynamically imported module'))
        : Promise.resolve(module.source)
    })

    await assert.rejects(engines.acquire(), /Failed to fetch dynamically imported module/)
    await engines.acquire()

    assert.equal(imports, 2)
    assert.equal(module.acquired(), 1)
  })

  test('shares one import between layouts asked for while it is under way, failing them together', async () => {
    let imports = 0
    let failImport: (error: Error) => void = () => undefined
    const engines = lazyElkEngineSource(() => {
      imports += 1
      return new Promise((_, reject) => {
        failImport = reject
      })
    })

    const layouts = [engines.acquire(), engines.acquire()]
    failImport(new TypeError('Failed to fetch dynamically imported module'))

    for (const layout of layouts) {
      await assert.rejects(layout, /Failed to fetch/)
    }
    assert.equal(imports, 1)
  })
})

describe('failureSignal', () => {
  test('fails when told to, with what it was told, as an engine failure', async () => {
    const { failure, fail } = failureSignal()
    const cause = new Error('gone')

    fail(cause)

    await assert.rejects(failure, (error: unknown) =>
      error instanceof ElkEngineFailure && error.message === 'gone' && error.cause === cause
    )
  })

  test('keeps an engine failure it is told as it is', async () => {
    const { failure, fail } = failureSignal()
    const told = new ElkEngineFailure('the worker died')

    fail(told)

    await assert.rejects(failure, (error: unknown) => error === told)
  })

  test('fails quietly with nobody waiting', async () => {
    const { fail } = failureSignal()

    // An unhandled rejection would fail this run.
    fail(new Error('nobody is listening'))
    await settle()
  })

  test('fails every guarded layout still waiting, with the first failure only', async () => {
    const { fail, guard } = failureSignal()
    const waiting = [
      guard(() => new Promise<ElkNode>(() => {})),
      guard(() => new Promise<ElkNode>(() => {}))
    ]

    fail(new Error('the worker died'))
    fail(new Error('and was stopped'))

    for (const layout of waiting) {
      await assert.rejects(layout, /the worker died/)
    }
  })

  test('fails a layout asked for after the failure at once, without starting it', async () => {
    const { fail, guard } = failureSignal()
    let started = 0

    fail(new Error('the worker died'))
    await assert.rejects(guard(() => {
      started += 1
      return Promise.resolve(GRAPH)
    }), /the worker died/)
    assert.equal(started, 0)
  })

  test('leaves a layout that has settled as it settled when the engine fails after', async () => {
    const { fail, guard } = failureSignal()

    const answered = guard(() => Promise.resolve(GRAPH))
    const refused = guard(() => Promise.reject(new Error('ELK refused the graph')))
    await assert.rejects(refused, /refused the graph/)
    fail(new Error('the worker died'))

    assert.deepEqual(await answered, GRAPH)
  })

  test('fails a layout whose work throws, as one that rejects', async () => {
    const { guard } = failureSignal()

    await assert.rejects(guard(() => {
      throw new Error('could not post the graph')
    }), /could not post the graph/)
  })
})
