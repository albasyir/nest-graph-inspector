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
    const started: Started = { running: startRunning(), startedAt, isReady: false }
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
    abort: () => {
      const stopping = current
      current = undefined
      void stopping?.running.then(running => running.stop(), () => undefined)
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
 * and has nothing to abort. A failed import fails that layout, and the next
 * one imports again.
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
    abort: () => loaded?.abort(),
    load: () => load().then(() => undefined, () => undefined)
  }
}

/**
 * A promise that only ever fails, and the means to fail it. Nothing may be
 * waiting when it fails — a worker can die between layouts — so it never
 * reports itself unhandled.
 */
export function failureSignal(): {
  failure: Promise<never>
  fail: (error: Error) => void
} {
  let fail: (error: Error) => void = () => undefined
  const failure = new Promise<never>((_, reject) => {
    fail = reject
  })
  failure.catch(() => undefined)

  return { failure, fail }
}
