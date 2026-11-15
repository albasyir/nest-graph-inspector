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
import type { ElkEngineSource, ElkRuntime } from './module-graph-auto-layout.ts'

const WARM_UP_GRAPH: ElkNode = { id: 'warm-up' }
const GRAPH: ElkNode = { id: 'graph' }

/** Lets every callback already queued run. */
function settle(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/**
 * A stand-in ELK, as a worker would be: its layouts answer only when told to,
 * and it can be stopped, or die on its own.
 */
function standIn(runtime: ElkRuntime = 'worker') {
  const requested: ElkNode[] = []
  const unanswered: (() => void)[] = []
  const { failure, fail, guard } = failureSignal()
  let isStopped = false
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
    stop: () => {
      isStopped = true
      fail(new Error('stopped'))
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
    isStopped: () => isStopped,
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

describe('aborting', () => {
  test('stops the engine, fails what it was laying out, and starts another next time', async () => {
    const workers = [standIn(), standIn()]
    const { engines, starts } = sourceOver(workers)

    // Awaited as a layout awaits it, from before the abort.
    const abandoned = assert.rejects(
      (await engines.acquire()).layout(GRAPH),
      /stopped/
    )
    engines.abort()
    await settle()

    await abandoned
    assert.equal(workers[0]?.isStopped(), true)
    assert.equal(engines.isReady(), false)

    const next = (await engines.acquire()).layout(GRAPH)
    await workers[1]?.answerAll()

    assert.deepEqual(await next, GRAPH)
    assert.equal(starts(), 2)
  })

  test('drops a layout still waiting for ELK to start, which ELK never lays out', async () => {
    const [abandonedElk, nextElk] = [standIn('main-thread'), standIn('main-thread')]
    const starting: ((running: RunningElk) => void)[] = []
    const engines = createSharedElkEngineSource({
      startWorker: () => undefined,
      startOnThisThread: () => new Promise((resolve) => {
        starting.push(resolve)
      }),
      warmUpGraph: WARM_UP_GRAPH
    })

    const abandoned = assert.rejects(engines.acquire(), /stopped before it had started/)
    engines.abort()
    starting[0]?.(abandonedElk.running)
    await abandoned
    await settle()
    assert.deepEqual(abandonedElk.requested, [])
    assert.equal(abandonedElk.isStopped(), true)

    // The next layout starts ELK afresh, and is laid out.
    const next = engines.acquire().then(engine => engine.layout(GRAPH))
    await settle()
    starting[1]?.(nextElk.running)
    await settle()
    await nextElk.answerAll()
    assert.deepEqual(await next, GRAPH)
    assert.equal(starting.length, 2)
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
  test('a worker that dies fails its layouts, and is replaced by the next one', async () => {
    const workers = [standIn(), standIn()]
    const { engines, starts } = sourceOver(workers)

    const failed = (await engines.acquire()).layout(GRAPH)
    workers[0]?.die()

    await assert.rejects(failed, /did not load/)
    await settle()
    await engines.acquire()
    assert.equal(starts(), 2)
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
    let aborted = 0
    const source: ElkEngineSource = {
      isReady: () => isReady,
      acquire: () => {
        acquired += 1
        return Promise.resolve({ runtime: 'worker', layout: graph => Promise.resolve(graph) })
      },
      abort: () => {
        aborted += 1
      }
    }

    return { source, acquired: () => acquired, aborted: () => aborted }
  }

  test('is not ready, and aborts nothing, before its module is imported', () => {
    const engines = lazyElkEngineSource(() => Promise.resolve(inner(true).source))

    assert.equal(engines.isReady(), false)
    engines.abort()
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
    engines.abort()
    assert.equal(module.aborted(), 1)
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
        ? Promise.reject(new Error('the chunk failed to load'))
        : Promise.resolve(module.source)
    })

    await assert.rejects(engines.acquire(), /failed to load/)
    await engines.acquire()

    assert.equal(imports, 2)
  })

  test('drops a layout still waiting for its module when it aborts, never starting ELK for it', async () => {
    const module = inner(false)
    let finishImport: (source: ElkEngineSource) => void = () => undefined
    const engines = lazyElkEngineSource(() => new Promise((resolve) => {
      finishImport = resolve
    }))

    const abandoned = assert.rejects(engines.acquire(), /stopped before it had loaded/)
    engines.abort()
    finishImport(module.source)
    await abandoned

    assert.equal(module.acquired(), 0)
    // A layout asked for after the abort is served as any other.
    await engines.acquire()
    assert.equal(module.acquired(), 1)
  })
})

describe('failureSignal', () => {
  test('fails when told to, with what it was told', async () => {
    const { failure, fail } = failureSignal()

    fail(new Error('gone'))

    await assert.rejects(failure, /gone/)
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
