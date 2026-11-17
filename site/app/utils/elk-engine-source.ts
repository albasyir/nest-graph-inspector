import type { ElkNode } from 'elkjs/lib/elk-api'
import {
  ElkEngineFailure,
  type ElkEngine,
  type ElkEngineSource,
  type ElkRuntime
} from './module-graph-auto-layout.ts'

/**
 * The page's one ELK, shared by every graph it lays out: started once — early,
 * by a page that knows it is about to draw a graph — and, should it fail, let
 * go of at once and started afresh by the next layout.
 *
 * ELK runs in a worker wherever one can be made, off the thread the page draws
 * on, so a large graph never freezes the page. Where no worker can be made — a
 * browser without them, a page whose policy forbids one — it runs on this
 * thread instead: the same layout, paid for in the page's own time.
 *
 * Pure apart from what it is handed, so a test drives it with stand-ins; the
 * worker itself is made in `module-layout-engine.ts`.
 */

/** ELK, started. */
export type RunningElk = {
  engine: ElkEngine
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
    /** Resolves once it has finished its first layout; rejects if it fails first. */
    ready: Promise<void>
    resolveReady: () => void
    rejectReady: (error: unknown) => void
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
    let resolveReady: () => void = () => undefined
    let rejectReady: (error: unknown) => void = () => undefined
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // Nothing need be waiting on it when the engine fails.
    ready.catch(() => undefined)
    const started: Started = {
      running: startRunning(),
      startedAt: now(),
      isReady: false,
      ready,
      resolveReady,
      rejectReady
    }
    // An engine that could not start, or that died on its own, is forgotten
    // at once, so the next layout — a retry included — starts another.
    started.running.then(
      running => running.failure?.catch((error: unknown) => forget(started, error)),
      (error: unknown) => forget(started, error)
    )
    return started
  }

  function ensureStarted(): Started {
    current ??= start()
    return current
  }

  function forget(started: Started, error: unknown): void {
    started.rejectReady(error)
    if (current === started) {
      current = undefined
    }
  }

  function markReady(started: Started, runtime: ElkRuntime): void {
    if (started.isReady || current !== started) {
      return
    }

    started.isReady = true
    started.resolveReady()
    onReady?.({ start: started.startedAt, end: now(), runtime })
  }

  /** The engine, telling the source when it has finished its first layout. */
  function engineOf(started: Started): Promise<ElkEngine> {
    return started.running.then(({ engine }) => ({
      runtime: engine.runtime,
      layout: graph => engine.layout(graph).then((laidOut) => {
        markReady(started, engine.runtime)
        return laidOut
      })
    }))
  }

  return {
    isReady: () => current?.isReady ?? false,
    acquire: () => engineOf(ensureStarted()),
    whenReady: () => current
      ? current.ready
      : Promise.reject(new ElkEngineFailure('ELK is not running')),
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
 * it is needed — or when `load` asks for it early. Until then it is not ready.
 * A failed import fails that layout, and the next one imports again: the
 * browser fetches a module whose fetch failed afresh — Chromium 156 and 159
 * were checked — so a transient failure does not stick.
 */
export function lazyElkEngineSource(
  importSource: () => Promise<ElkEngineSource>
): LazyElkEngineSource {
  let loaded: ElkEngineSource | undefined
  let loading: Promise<ElkEngineSource> | undefined

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
    acquire: () => load().then(source => source.acquire()),
    whenReady: () => loaded
      ? loaded.whenReady()
      : Promise.reject(new ElkEngineFailure('ELK is not loaded')),
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
 *
 * Whatever it fails with is an `ElkEngineFailure`, so a layout that fails
 * because the engine did is told apart from one ELK refused.
 */
export function failureSignal(): {
  failure: Promise<never>
  fail: (error: Error) => void
  guard: <T>(work: () => Promise<T>) => Promise<T>
} {
  let failedWith: ElkEngineFailure | undefined
  const waiting = new Set<(error: ElkEngineFailure) => void>()
  let rejectFailure: (error: ElkEngineFailure) => void = () => undefined
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject
  })
  failure.catch(() => undefined)

  function fail(error: Error): void {
    if (failedWith) {
      return
    }

    failedWith = error instanceof ElkEngineFailure
      ? error
      : new ElkEngineFailure(error.message, { cause: error })
    rejectFailure(failedWith)
    for (const reject of waiting) {
      reject(failedWith)
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
