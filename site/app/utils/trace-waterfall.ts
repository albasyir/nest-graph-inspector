import type {
  GraphOutput,
  RuntimeTrace,
  RuntimeTraceSpan
} from 'nest-graph-inspector'

/**
 * The narrowest a bar is drawn, as a percentage of the timeline.
 *
 * A span that took no measurable time is still a span that ran; drawn at its
 * true width it would be invisible, and a waterfall row with no bar reads as
 * a span that never happened.
 */
export const MIN_BAR_WIDTH_PERCENT = 0.75

/** One row of the waterfall: a span, where it sits in the tree and on the timeline. */
export type WaterfallRow = {
  span: RuntimeTraceSpan
  /** 0 for a root span, one more for each ancestor. */
  depth: number
  hasChildren: boolean
  /** Whether this row's descendants are hidden. Only ever true when it has some. */
  isCollapsed: boolean
  /** Milliseconds from the start of the trace to the start of this span. */
  offsetMs: number
  /** Where the bar starts, as a percentage of the trace's duration. */
  leftPercent: number
  /** How wide the bar is, as a percentage of the trace's duration. */
  widthPercent: number
}

export type TimelineTick = {
  valueMs: number
  /** Position on the timeline, as a percentage of the trace's duration. */
  percent: number
  label: string
}

export type SpanKind = 'controller' | 'provider' | 'unknown'

export type SpanStatusColor = 'success' | 'error' | 'warning' | 'neutral'

export type SpanStatus = {
  label: string
  color: SpanStatusColor
  /** The span returned a promise its caller never awaited. */
  isNotAwaited: boolean
}

function timeOf(iso: string): number {
  const time = new Date(iso).getTime()
  return Number.isFinite(time) ? time : 0
}

function compareSpans(a: RuntimeTraceSpan, b: RuntimeTraceSpan): number {
  return timeOf(a.startedAt) - timeOf(b.startedAt) || a.order - b.order
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Flattens a trace into waterfall rows, parents before their children.
 *
 * Spans are ordered by start time within each level. A span whose parent is not
 * in the trace is shown as a root rather than dropped, and so is any span a
 * malformed parent chain would otherwise make unreachable: a trace that lost a
 * span still shows every span it kept.
 *
 * A span in `collapsedSpanIds` keeps its own row and hides every descendant.
 * Bars are placed against the trace's total duration and kept inside the
 * timeline, never narrower than `minWidthPercent`.
 */
export function buildSpanHierarchy(
  trace: Pick<RuntimeTrace, 'startedAt' | 'totalDurationMs' | 'spans'>,
  collapsedSpanIds: ReadonlySet<string> = new Set(),
  minWidthPercent = MIN_BAR_WIDTH_PERCENT
): WaterfallRow[] {
  const traceStart = timeOf(trace.startedAt)
  // A trace that took no measurable time still has to be drawn; every span in
  // it starts at 0 and gets the minimum width.
  const totalMs = trace.totalDurationMs > 0 ? trace.totalDurationMs : 1
  const spans = [...trace.spans].sort(compareSpans)
  const spanIds = new Set(spans.map(span => span.spanId))
  const childrenByParentId = new Map<string, RuntimeTraceSpan[]>()
  const roots: RuntimeTraceSpan[] = []

  for (const span of spans) {
    const parentId = span.parentSpanId
    if (parentId && parentId !== span.spanId && spanIds.has(parentId)) {
      const siblings = childrenByParentId.get(parentId) ?? []
      siblings.push(span)
      childrenByParentId.set(parentId, siblings)
    } else {
      roots.push(span)
    }
  }

  const rows: WaterfallRow[] = []
  const visited = new Set<string>()

  const visit = (span: RuntimeTraceSpan, depth: number, hidden: boolean) => {
    if (visited.has(span.spanId)) {
      return
    }
    visited.add(span.spanId)

    const children = childrenByParentId.get(span.spanId) ?? []
    const isCollapsed = children.length > 0 && collapsedSpanIds.has(span.spanId)

    if (!hidden) {
      const offsetMs = Math.max(0, timeOf(span.startedAt) - traceStart)
      const leftPercent = clamp((offsetMs / totalMs) * 100, 0, 100 - minWidthPercent)
      const widthPercent = clamp(
        (Math.max(0, span.durationMs) / totalMs) * 100,
        minWidthPercent,
        100 - leftPercent
      )

      rows.push({
        span,
        depth,
        hasChildren: children.length > 0,
        isCollapsed,
        offsetMs,
        leftPercent,
        widthPercent
      })
    }

    // Descendants of a collapsed row are still walked, so a span hidden below
    // it is not mistaken for an unreachable one and promoted to a root.
    for (const child of children) {
      visit(child, depth + 1, hidden || isCollapsed)
    }
  }

  for (const root of roots) {
    visit(root, 0, false)
  }

  // Spans whose parent chain loops back on itself are reachable from no root.
  for (const span of spans) {
    visit(span, 0, false)
  }

  return rows
}

/** The steps a ruler may use, per power of ten. */
const NICE_STEPS = [1, 2, 2.5, 5, 10]

/**
 * Evenly spaced ruler ticks from 0 up to `totalDurationMs`, on round numbers.
 *
 * The step is the smallest of 1, 2, 2.5 or 5 times a power of ten that yields
 * at most `targetCount` intervals, so a 93 ms trace is marked every 20 ms, not
 * every 18.6. Steps never go below 1 ms: the recorder measures whole
 * milliseconds.
 */
export function computeTimelineRulerTicks(
  totalDurationMs: number,
  targetCount = 5
): TimelineTick[] {
  if (!(totalDurationMs > 0)) {
    return [{ valueMs: 0, percent: 0, label: '0 ms' }]
  }

  const rawStep = totalDurationMs / Math.max(1, Math.floor(targetCount))
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const factor = NICE_STEPS.find(step => step * magnitude >= rawStep) ?? 10
  const step = Math.max(1, factor * magnitude)

  const ticks: TimelineTick[] = []
  // Multiplying rather than accumulating keeps float drift out of the labels.
  for (let index = 0; index * step <= totalDurationMs; index++) {
    const valueMs = Number((index * step).toPrecision(12))
    ticks.push({
      valueMs,
      percent: (valueMs / totalDurationMs) * 100,
      label: valueMs === 0 ? '0 ms' : formatDuration(valueMs)
    })
  }

  return ticks
}

/**
 * Whether a span ran on a controller or a provider.
 *
 * The recorder knows, but does not keep it: a trace records a span's module
 * and class only. A `type` in the span's metadata is honoured if a recorder
 * writes one; otherwise the graph decides, and only when the class is one or
 * the other in that module — a module holding a provider and a controller of
 * the same name leaves it `unknown`, never a guess.
 */
export function resolveSpanKind(
  span: Pick<RuntimeTraceSpan, 'moduleName' | 'className' | 'metadata'>,
  graph?: Pick<GraphOutput, 'modules'> | null
): SpanKind {
  const recorded = span.metadata?.type
  if (recorded === 'controller' || recorded === 'provider') {
    return recorded
  }

  const { moduleName, className } = span
  const moduleData = graph && moduleName && Object.hasOwn(graph.modules, moduleName)
    ? graph.modules[moduleName]
    : undefined

  if (!moduleData || !className) {
    return 'unknown'
  }

  const isProvider = moduleData.providers.some(provider => provider.name === className)
  const isController = moduleData.controllers.some(controller => controller.name === className)

  if (isProvider === isController) {
    return 'unknown'
  }

  return isController ? 'controller' : 'provider'
}

/** Whether a span returned a promise that nothing awaited. */
export function isNotAwaitedSpan(span: Pick<RuntimeTraceSpan, 'metadata'>): boolean {
  return span.metadata?.awaited === false
}

/**
 * How a span ended, for a badge and a bar colour.
 *
 * An error outranks everything — a rejected promise nobody awaited is still a
 * rejection — and `isNotAwaited` is reported alongside whatever the label
 * says, so that warning is never lost to it.
 */
export function resolveSpanStatus(
  span: Pick<RuntimeTraceSpan, 'status' | 'metadata'>
): SpanStatus {
  const isNotAwaited = isNotAwaitedSpan(span)

  if (span.status === 'error') {
    return { label: 'Error', color: 'error', isNotAwaited }
  }
  if (isNotAwaited) {
    return { label: 'Not awaited', color: 'warning', isNotAwaited }
  }
  if (span.status === 'partial') {
    return { label: 'Partial', color: 'neutral', isNotAwaited }
  }
  if (span.status === 'cancelled') {
    return { label: 'Cancelled', color: 'neutral', isNotAwaited }
  }
  if (span.status === 'success') {
    return { label: 'Success', color: 'success', isNotAwaited }
  }

  return { label: 'Unknown', color: 'neutral', isNotAwaited }
}

/**
 * How a whole trace ended. A failed trace is a failure; one that otherwise
 * succeeded but left a promise unawaited says so, since that is the thing
 * worth noticing.
 */
export function resolveTraceStatus(
  trace: Pick<RuntimeTrace, 'status'> & Partial<Pick<RuntimeTrace, 'spans'>>
): Omit<SpanStatus, 'isNotAwaited'> {
  if (trace.status === 'error') {
    return { label: 'Fail', color: 'error' }
  }
  if (trace.spans?.some(isNotAwaitedSpan)) {
    return { label: 'Not awaited', color: 'warning' }
  }
  if (trace.status === 'partial') {
    return { label: 'Partial', color: 'neutral' }
  }

  return { label: 'Success', color: 'success' }
}

/** `14 ms`, `1.25 s`, or `< 1 ms` for a span too quick to measure. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return '—'
  }
  if (ms < 1) {
    return '< 1 ms'
  }
  // Rounded first, so 999.6 ms reads as 1 s rather than 1000 ms.
  if (Math.round(ms) < 1000) {
    return `${Math.round(ms)} ms`
  }

  return `${Number((ms / 1000).toFixed(2))} s`
}

/** `ClassName.methodName()`, or the span's own name when it has no method. */
export function spanLabel(
  span: Pick<RuntimeTraceSpan, 'name' | 'className' | 'methodName'>
): string {
  return span.methodName
    ? `${span.className ?? span.name}.${span.methodName}()`
    : span.name
}
