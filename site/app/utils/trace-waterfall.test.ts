import { strict as assert } from 'node:assert'
import type { RuntimeTrace, RuntimeTraceSpan } from 'nest-graph-inspector'
import {
  MIN_BAR_WIDTH_PERCENT,
  buildSpanHierarchy,
  computeTimelineRulerTicks,
  formatDuration,
  resolveSpanKind,
  resolveSpanStatus,
  resolveTraceStatus,
  spanLabel
} from './trace-waterfall.ts'

const T0 = Date.parse('2026-01-01T00:00:00.000Z')

function span(
  spanId: string,
  startMs: number,
  durationMs: number,
  extra: Partial<RuntimeTraceSpan> = {}
): RuntimeTraceSpan {
  return {
    spanId,
    runId: 'run-1',
    order: 0,
    name: spanId,
    startedAt: new Date(T0 + startMs).toISOString(),
    durationMs,
    status: 'success',
    ...extra
  }
}

function trace(spans: RuntimeTraceSpan[], totalDurationMs = 100): RuntimeTrace {
  return {
    traceId: 'trace-1',
    runId: 'run-1',
    entrypoint: { methodName: 'checkout', className: 'OrderService' },
    startedAt: new Date(T0).toISOString(),
    endedAt: new Date(T0 + totalDurationMs).toISOString(),
    totalDurationMs,
    status: 'success',
    totalSpans: spans.length,
    spans
  }
}

const ids = (rows: { span: RuntimeTraceSpan }[]) => rows.map(row => row.span.spanId)

// OrderService.checkout → { UserService.find → UserRepository.get, Mailer.send }
// Listed out of order on purpose: the hierarchy must not depend on the
// recorder's array order, only on parent links and start times.
const checkout = trace([
  span('send', 60, 30, { parentSpanId: 'root', order: 4 }),
  span('get', 15, 20, { parentSpanId: 'find', order: 3 }),
  span('root', 0, 100, { order: 1 }),
  span('find', 10, 40, { parentSpanId: 'root', order: 2 })
])

// Hierarchy: parents before children, siblings by start time, depth per level.
{
  const rows = buildSpanHierarchy(checkout)
  assert.deepEqual(ids(rows), ['root', 'find', 'get', 'send'])
  assert.deepEqual(rows.map(row => row.depth), [0, 1, 2, 1])
  assert.deepEqual(rows.map(row => row.hasChildren), [true, true, false, false])
  assert.ok(rows.every(row => !row.isCollapsed), 'nothing was collapsed')
}

// Two roots stay two roots, in start order.
{
  const rows = buildSpanHierarchy(trace([span('b', 50, 10), span('a', 0, 10)]))
  assert.deepEqual(ids(rows), ['a', 'b'])
  assert.deepEqual(rows.map(row => row.depth), [0, 0])
}

// Same start time falls back to the recorder's order.
{
  const rows = buildSpanHierarchy(trace([
    span('second', 0, 1, { order: 2 }),
    span('first', 0, 1, { order: 1 })
  ]))
  assert.deepEqual(ids(rows), ['first', 'second'])
}

// Collapsing a span keeps its row, flags it, and hides every descendant —
// grandchildren included, not just direct children.
{
  const rows = buildSpanHierarchy(checkout, new Set(['root']))
  assert.deepEqual(ids(rows), ['root'])
  assert.equal(rows[0]?.isCollapsed, true)
  assert.equal(rows[0]?.hasChildren, true)
}
{
  const rows = buildSpanHierarchy(checkout, new Set(['find']))
  assert.deepEqual(ids(rows), ['root', 'find', 'send'])
  assert.equal(rows.find(row => row.span.spanId === 'find')?.isCollapsed, true)
}

// A leaf cannot be collapsed: there is nothing under it to hide.
{
  const rows = buildSpanHierarchy(checkout, new Set(['get']))
  assert.deepEqual(ids(rows), ['root', 'find', 'get', 'send'])
  assert.equal(rows.find(row => row.span.spanId === 'get')?.isCollapsed, false)
}

// A span whose parent is not in the trace is still shown, as a root.
{
  const rows = buildSpanHierarchy(trace([span('orphan', 5, 5, { parentSpanId: 'gone' })]))
  assert.deepEqual(ids(rows), ['orphan'])
  assert.equal(rows[0]?.depth, 0)
}

// A parent chain that loops back on itself loses no span and does not hang.
{
  const rows = buildSpanHierarchy(trace([
    span('x', 0, 5, { parentSpanId: 'y' }),
    span('y', 1, 5, { parentSpanId: 'x' }),
    span('self', 2, 5, { parentSpanId: 'self' })
  ]))
  assert.deepEqual([...ids(rows)].sort(), ['self', 'x', 'y'])
}

// Timing: offsets from the trace start, and percentages of its duration.
{
  const rows = buildSpanHierarchy(checkout)
  const get = rows.find(row => row.span.spanId === 'get')!
  assert.equal(get.offsetMs, 15)
  assert.equal(get.leftPercent, 15)
  assert.equal(get.widthPercent, 20)

  const root = rows.find(row => row.span.spanId === 'root')!
  assert.equal(root.offsetMs, 0)
  assert.equal(root.leftPercent, 0)
  assert.equal(root.widthPercent, 100)
}

// A span faster than the clock still gets a visible bar.
{
  const [row] = buildSpanHierarchy(trace([span('instant', 40, 0)], 200))
  assert.equal(row?.widthPercent, MIN_BAR_WIDTH_PERCENT)
  assert.equal(row?.leftPercent, 20)
}
{
  const [row] = buildSpanHierarchy(trace([span('instant', 0, 0)]), new Set(), 2)
  assert.equal(row?.widthPercent, 2, 'the minimum width is configurable')
}

// A span that started before the trace (clock skew) is pinned to 0.
{
  const [row] = buildSpanHierarchy(trace([span('early', -5, 10)]))
  assert.equal(row?.offsetMs, 0)
  assert.equal(row?.leftPercent, 0)
}

// Bars never run off the end of the timeline, however late or long the span.
{
  const rows = buildSpanHierarchy(trace([
    span('late', 95, 50),
    span('after', 150, 10)
  ]))
  for (const row of rows) {
    assert.ok(
      row.leftPercent + row.widthPercent <= 100 + 1e-9,
      `${row.span.spanId} overflows: ${row.leftPercent} + ${row.widthPercent}`
    )
    assert.ok(row.widthPercent >= MIN_BAR_WIDTH_PERCENT)
  }
}

// A trace that took no measurable time is still drawable — no NaN, no Infinity.
{
  const rows = buildSpanHierarchy(trace([span('a', 0, 0), span('b', 0, 0)], 0))
  for (const row of rows) {
    assert.ok(Number.isFinite(row.leftPercent) && Number.isFinite(row.widthPercent))
  }
}

// Ruler ticks: round steps, starting at 0, never past the total.
assert.deepEqual(
  computeTimelineRulerTicks(100).map(tick => tick.valueMs),
  [0, 20, 40, 60, 80, 100]
)
assert.deepEqual(
  computeTimelineRulerTicks(93).map(tick => tick.label),
  ['0 ms', '20 ms', '40 ms', '60 ms', '80 ms']
)
assert.deepEqual(
  computeTimelineRulerTicks(120).map(tick => tick.valueMs),
  [0, 25, 50, 75, 100]
)
assert.deepEqual(
  computeTimelineRulerTicks(2400).map(tick => tick.label),
  ['0 ms', '500 ms', '1 s', '1.5 s', '2 s']
)
assert.deepEqual(
  computeTimelineRulerTicks(100, 10).map(tick => tick.valueMs),
  [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
)
// Percentages line up with the values, so gridlines sit under their labels.
for (const tick of computeTimelineRulerTicks(93)) {
  assert.equal(tick.percent, (tick.valueMs / 93) * 100)
}
// Sub-millisecond steps make no sense for whole-millisecond timings.
assert.deepEqual(
  computeTimelineRulerTicks(3).map(tick => tick.valueMs),
  [0, 1, 2, 3]
)
// Nothing to measure is one tick, not an empty or infinite ruler.
assert.deepEqual(computeTimelineRulerTicks(0), [{ valueMs: 0, percent: 0, label: '0 ms' }])
assert.equal(computeTimelineRulerTicks(Number.NaN).length, 1)
// Every step stays within the requested count, whatever the duration.
for (const total of [1, 7, 13, 99, 101, 999, 1001, 4321, 60_000]) {
  const ticks = computeTimelineRulerTicks(total, 5)
  assert.ok(ticks.length >= 2 && ticks.length <= 6, `${total} ms gave ${ticks.length} ticks`)
  assert.ok(ticks.at(-1)!.valueMs <= total)
}

// Status: an error outranks a missing await, which outranks everything else,
// and the missing await is reported either way.
assert.deepEqual(resolveSpanStatus({ status: 'success' }), {
  label: 'Success',
  color: 'success',
  isNotAwaited: false
})
assert.deepEqual(resolveSpanStatus({ status: 'error' }), {
  label: 'Error',
  color: 'error',
  isNotAwaited: false
})
assert.deepEqual(
  resolveSpanStatus({ status: 'partial', metadata: { async: true, awaited: false } }),
  { label: 'Not awaited', color: 'warning', isNotAwaited: true }
)
assert.deepEqual(
  resolveSpanStatus({ status: 'error', metadata: { awaited: false } }),
  { label: 'Error', color: 'error', isNotAwaited: true }
)
assert.equal(resolveSpanStatus({ status: 'partial' }).label, 'Partial')
assert.equal(resolveSpanStatus({ status: 'cancelled' }).color, 'neutral')
assert.equal(resolveSpanStatus({ status: 'unknown' }).label, 'Unknown')
// Awaited explicitly is not a warning.
assert.equal(resolveSpanStatus({ status: 'success', metadata: { awaited: true } }).isNotAwaited, false)

assert.equal(resolveTraceStatus({ status: 'error' }).label, 'Fail')
assert.equal(resolveTraceStatus({ status: 'success' }).label, 'Success')
assert.deepEqual(
  resolveTraceStatus({
    status: 'success',
    spans: [span('a', 0, 1, { status: 'partial', metadata: { awaited: false } })]
  }),
  { label: 'Not awaited', color: 'warning' }
)

// Kind: the graph decides, and a class that is both in its module stays unknown.
const graph = {
  modules: {
    OrderModule: {
      imports: [],
      exports: [],
      providers: [
        { name: 'OrderService', dependencies: [] },
        { name: 'Shared', dependencies: [] }
      ],
      controllers: [
        { name: 'OrderController', dependencies: [] },
        { name: 'Shared', dependencies: [] }
      ]
    }
  }
}
assert.equal(resolveSpanKind({ moduleName: 'OrderModule', className: 'OrderService' }, graph), 'provider')
assert.equal(resolveSpanKind({ moduleName: 'OrderModule', className: 'OrderController' }, graph), 'controller')
assert.equal(resolveSpanKind({ moduleName: 'OrderModule', className: 'Shared' }, graph), 'unknown')
assert.equal(resolveSpanKind({ moduleName: 'OrderModule', className: 'Missing' }, graph), 'unknown')
assert.equal(resolveSpanKind({ moduleName: 'NoSuchModule', className: 'OrderService' }, graph), 'unknown')
// A module name that is an inherited property is not a module.
assert.equal(resolveSpanKind({ moduleName: 'constructor', className: 'OrderService' }, graph), 'unknown')
assert.equal(resolveSpanKind({ moduleName: 'OrderModule', className: 'OrderService' }), 'unknown')
assert.equal(resolveSpanKind({ moduleName: 'OrderModule', className: 'OrderService' }, null), 'unknown')
// A kind the recorder wrote down wins over the graph.
assert.equal(
  resolveSpanKind({ moduleName: 'OrderModule', className: 'Shared', metadata: { type: 'controller' } }, graph),
  'controller'
)
assert.equal(
  resolveSpanKind({ moduleName: 'OrderModule', className: 'OrderService', metadata: { type: 'database' } }, graph),
  'provider',
  'a type that is neither falls back to the graph'
)

// Durations.
assert.equal(formatDuration(0), '< 1 ms')
assert.equal(formatDuration(0.4), '< 1 ms')
assert.equal(formatDuration(1), '1 ms')
assert.equal(formatDuration(14), '14 ms')
assert.equal(formatDuration(14.6), '15 ms')
assert.equal(formatDuration(999), '999 ms')
assert.equal(formatDuration(999.6), '1 s')
assert.equal(formatDuration(1250), '1.25 s')
assert.equal(formatDuration(2000), '2 s')
assert.equal(formatDuration(-1), '—')
assert.equal(formatDuration(Number.NaN), '—')

// Labels.
assert.equal(
  spanLabel({ name: 'OrderService.checkout', className: 'OrderService', methodName: 'checkout' }),
  'OrderService.checkout()'
)
assert.equal(spanLabel({ name: 'bootstrap' }), 'bootstrap')

console.log('trace-waterfall.test.ts ok')
