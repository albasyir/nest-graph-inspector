import type { ElkNode } from 'elkjs/lib/elk-api'
import type {
  ElkEngine,
  ElkEngineSource,
  ElkRuntime
} from './module-graph-auto-layout.ts'

/**
 * The page's one ELK, shared by every graph it lays out: started once —
 * early, by a page that knows it is about to draw a graph — stopped when a
 * layout runs past its deadline, and started afresh when next asked for.
 *
 * ELK runs in a worker wherever one can be made, off the thread the page draws
 * on, so a large graph never freezes the page and a stuck layout can be
 * stopped. Where no worker can be made — a browser without them, a page whose
 * policy forbids one — it runs on this thread instead: the same layout, paid
 * for in the page's own time.
 *
 * Pure apart from what it is handed, so a test drives it with stand-ins; the
 * worker itself is made in `module-layout-engine.ts`.
 */

/** ELK running somewhere it can be stopped. */
export type RunningElk = {
  engine: ElkEngine
  /** Stops it, failing whatever it is laying out. */
  stop: () => void
  /** Fails when it dies on its own, as a worker whose script will not load does. */
  failure?: Promise<never>
}

/** How long an engine took from being started to its first layout done. */
export type ElkEngineReadyTiming = {
  start: number
  end: number
  runtime: ElkRuntime
}

export type SharedElkEngineSource = ElkEngineSource & {
  /**
   * Starts ELK, unless it is running, and has it lay a small graph out, so the
   * first real layout finds it loaded, compiled and warm.
   */
  warmUp: () => void
}

export function createSharedElkEngineSource(options: {
  /** ELK in a worker; `undefined` where no worker can be made. May throw. */
  startWorker: () => RunningElk | undefined
  /** ELK on this thread, for a page that cannot make a worker. */
  startOnThisThread: () => Promise<RunningElk>
  /** What a warm-up lays out. */
  warmUpGraph: ElkNode
  /**
   * How many times a warm-up lays it out. The first run compiles ELK's code;
   * the ones after it let the engine optimise the code a real layout runs.
   */
  warmUpRuns?: number
  /** Told when each engine has come up and finished its first layout. */
  onReady?: (timing: ElkEngineReadyTiming) => void
  now?: () => number
}): SharedElkEngineSource {
  const { startWorker, startOnThisThread, warmUpGraph, onReady } = options
  const warmUpRuns = Math.max(1, options.warmUpRuns ?? 1)
  const now = options.now ?? (() => performance.now())

  type Started = {
    running: Promise<RunningElk>
    startedAt: number
    isReady: boolean
    /** Set when the source aborts it, so a layout still waiting for it is dropped. */
    isAborted: boolean
  }
  let current: Started | undefined

  function startRunning(): Promise<RunningElk> {
    try {
      const worker = startWorker()
      if (worker) {
        return Promise.resolve(worker)
      }
    } catch {
      // No worker can be made here: ELK runs on this thread instead.
    }

    return startOnThisThread()
  }

  function start(): Started {
    const startedAt = now()
    const started: Started = { running: startRunning(), startedAt, isReady: false, isAborted: false }
    // An engine that could not start, or that died on its own, is forgotten,
    // so the next layout starts another.
    started.running.then(
      running => running.failure?.catch(() => forget(started)),
      () => forget(started)
    )
    return started
  }

  function ensureStarted(): Started {
    current ??= start()
    return current
  }

  function forget(started: Started): void {
    if (current === started) {
      current = undefined
    }
  }

  function markReady(started: Started, runtime: ElkRuntime): void {
    if (started.isReady || current !== started) {
      return
    }

    started.isReady = true
    onReady?.({ start: started.startedAt, end: now(), runtime })
  }

  /**
   * The engine, telling the source when it has finished its first layout — or,
   * when the source aborted it before it had started, a failure, so a layout
   * given up while it waited is never handed to ELK.
   */
  function engineOf(started: Started): Promise<ElkEngine> {
    return started.running.then(({ engine }) => {
      if (started.isAborted) {
        throw new Error('ELK was stopped before it had started')
      }

      return {
        runtime: engine.runtime,
        layout: graph => engine.layout(graph).then((laidOut) => {
          markReady(started, engine.runtime)
          return laidOut
        })
      }
    })
  }

  return {
    isReady: () => current?.isReady ?? false,
    acquire: () => engineOf(ensureStarted()),
    abort: () => {
      const stopping = current
      current = undefined
      if (!stopping) {
        return
      }

      stopping.isAborted = true
      void stopping.running.then(running => running.stop(), () => undefined)
    },
    warmUp: () => {
      if (current) {
        return
      }

      // All the runs are handed over at once, so ELK goes from one to the
      // next without waiting on this thread in between. A warm-up that fails
      // leaves the engine to the first real layout, which finds out the same
      // way and falls back.
      void engineOf(ensureStarted())
        .then(engine => Promise.all(
          Array.from({ length: warmUpRuns }, () => engine.layout(warmUpGraph))
        ))
        .catch(() => undefined)
    }
  }
}

export type LazyElkEngineSource = ElkEngineSource & {
  /** Imports the source now, ahead of the first layout, without starting ELK. */
  load: () => Promise<void>
}

/**
 * An engine source that lives in a module of its own, imported the first time
 * it is needed — or when `load` asks for it early. Until then it is not ready,
 * and an abort drops every layout still waiting for the import, so ELK is not
 * started for a layout already given up. A failed import fails that layout,
 * and the next one imports again.
 */
export function lazyElkEngineSource(
  importSource: () => Promise<ElkEngineSource>
): LazyElkEngineSource {
  let loaded: ElkEngineSource | undefined
  let loading: Promise<ElkEngineSource> | undefined
  /** How often the source has aborted, so a layout asked for before one is dropped. */
  let aborts = 0

  function load(): Promise<ElkEngineSource> {
    loading ??= importSource().then(
      (source) => {
        loaded = source
        return source
      },
      (error: unknown) => {
        loading = undefined
        throw error
      }
    )
    return loading
  }

  return {
    isReady: () => loaded?.isReady() ?? false,
    acquire: () => {
      const abortsWhenAsked = aborts
      return load().then((source) => {
        if (aborts !== abortsWhenAsked) {
          throw new Error('ELK was stopped before it had loaded')
        }

        return source.acquire()
      })
    },
    abort: () => {
      aborts += 1
      loaded?.abort()
    },
    load: () => load().then(() => undefined, () => undefined)
  }
}

/**
 * An engine's failure, and the means to fail it. `failure` fails the moment
 * the engine does; nothing may be waiting on it then — a worker can die
 * between layouts — so it never reports itself unhandled. `guard` runs one of
 * the engine's layouts so that it fails then too: a layout still waiting when
 * `fail` is called fails with it, and one asked for afterwards fails at once,
 * without being started. A guarded layout is let go of once it settles, so a
 * long-lived engine holds on to none of the layouts it has finished.
 */
export function failureSignal(): {
  failure: Promise<never>
  fail: (error: Error) => void
  guard: <T>(work: () => Promise<T>) => Promise<T>
} {
  let failedWith: Error | undefined
  const waiting = new Set<(error: Error) => void>()
  let rejectFailure: (error: Error) => void = () => undefined
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject
  })
  failure.catch(() => undefined)

  function fail(error: Error): void {
    if (failedWith) {
      return
    }

    failedWith = error
    rejectFailure(error)
    for (const reject of waiting) {
      reject(error)
    }
    waiting.clear()
  }

  function guard<T>(work: () => Promise<T>): Promise<T> {
    const failed = failedWith
    if (failed) {
      return Promise.reject(failed)
    }

    return new Promise<T>((resolve, reject) => {
      const letGo = () => waiting.delete(reject)
      waiting.add(reject)
      try {
        work().then(
          (value) => {
            letGo()
            resolve(value)
          },
          (error: unknown) => {
            letGo()
            reject(error)
          }
        )
      } catch (error) {
        letGo()
        reject(error)
      }
    })
  }

  return { failure, fail, guard }
}
