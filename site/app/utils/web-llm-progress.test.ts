import { strict as assert } from 'node:assert'
import { formatWebLlmProgress } from './web-llm-progress.ts'

// The report web-llm actually sends while a shard downloads.
assert.deepEqual(
  formatWebLlmProgress({ progress: 0.15789, text: 'Fetching param cache[6/38]: 512MB fetched.', timeElapsed: 12 }),
  { percent: 16, label: 'Fetching param cache[6/38]: 512MB fetched.', stage: 'Fetching param cache' }
)

// The panel keeps a history of stages, and web-llm writes the shard index, the
// megabytes and the seconds into every sentence — so two reports from the same
// step are only recognisable as one stage once the counters are off.
const fetchingShard = formatWebLlmProgress({ progress: 0.15, text: 'Fetching param cache[6/38]: 512MB fetched. 15% completed, 12 secs elapsed.' })
const fetchingNextShard = formatWebLlmProgress({ progress: 0.18, text: 'Fetching param cache[7/38]: 530MB fetched. 18% completed, 14 secs elapsed.' })

assert.notEqual(fetchingShard.label, fetchingNextShard.label)
assert.equal(fetchingShard.stage, fetchingNextShard.stage)
assert.equal(fetchingShard.stage, 'Fetching param cache')

// A different step has to stay a different stage, or the history collapses to
// one line for the whole load.
assert.equal(
  formatWebLlmProgress({ text: 'Loading GPU shader modules[3/10]: 4 secs elapsed.' }).stage,
  'Loading GPU shader modules'
)

// A sentence with no counters in it is its own stage, unchanged.
assert.deepEqual(formatWebLlmProgress({ progress: 0, text: 'Start to fetch params' }), {
  percent: 0,
  label: 'Start to fetch params',
  stage: 'Start to fetch params'
})
assert.deepEqual(formatWebLlmProgress({ progress: 1, text: 'Finish loading on WebGPU' }), {
  percent: 100,
  label: 'Finish loading on WebGPU',
  stage: 'Finish loading on WebGPU'
})
assert.equal(formatWebLlmProgress({ progress: 0.005 }).percent, 1)
assert.equal(formatWebLlmProgress({ progress: 0.004 }).percent, 0)

// The bar is driven straight from `percent`, so nothing here may produce a
// width the browser cannot read or one that overflows the track.
// A non-finite fraction reads as 0 rather than 100: it means the report told us
// nothing, and claiming the load is finished would be a lie the bar acts on.
for (const [progress, expected] of [
  [Number.NaN, 0],
  [Number.POSITIVE_INFINITY, 0],
  [Number.NEGATIVE_INFINITY, 0],
  [-1, 0],
  [-0.5, 0],
  [5, 100],
  [100, 100]
] as const) {
  const percent = formatWebLlmProgress({ progress }).percent
  assert.equal(percent, expected, `progress ${progress} should clamp to ${expected}`)
  assert.ok(Number.isInteger(percent), `progress ${progress} should give an integer`)
}

// A report with nothing in it arrives when a reload starts, and has to leave the
// panel with something to show.
assert.deepEqual(formatWebLlmProgress({}), { percent: 0, label: 'Preparing model', stage: 'Preparing model' })
assert.deepEqual(formatWebLlmProgress({ progress: 0.5, text: '' }), { percent: 50, label: 'Preparing model', stage: 'Preparing model' })
assert.deepEqual(formatWebLlmProgress({ progress: 0.5, text: '   ' }), { percent: 50, label: 'Preparing model', stage: 'Preparing model' })

// The label is passed through as web-llm wrote it, whitespace aside.
assert.equal(formatWebLlmProgress({ text: '  Loading model from cache  ' }).label, 'Loading model from cache')

console.log('web-llm-progress.test.ts ok')
