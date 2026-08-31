import { strict as assert } from 'node:assert'
import {
  CURATED_WEB_LLM_MODEL_IDS,
  RECOMMENDED_WEB_LLM_MODEL_ID,
  TOOL_TUNED_WEB_LLM_MODEL_IDS,
  buildWebLlmCatalog,
  formatModelVram,
  modelIsToolTuned,
  modelSupportsThinking,
  type WebLlmModelRecordLike
} from './web-llm-catalog.ts'

// The curated order is what the panel's menu shows, so it is part of the
// contract rather than an implementation detail.
assert.deepEqual(CURATED_WEB_LLM_MODEL_IDS, [
  'Qwen3-1.7B-q4f16_1-MLC',
  'Qwen3-0.6B-q4f16_1-MLC',
  'Qwen3-4B-q4f16_1-MLC',
  'Llama-3.2-1B-Instruct-q4f16_1-MLC',
  'Llama-3.2-3B-Instruct-q4f16_1-MLC',
  'Phi-3.5-mini-instruct-q4f16_1-MLC',
  'Hermes-2-Pro-Mistral-7B-q4f16_1-MLC',
  'Hermes-3-Llama-3.1-8B-q4f16_1-MLC'
])
assert.equal(RECOMMENDED_WEB_LLM_MODEL_ID, 'Qwen3-1.7B-q4f16_1-MLC')
assert.ok(CURATED_WEB_LLM_MODEL_IDS.includes(RECOMMENDED_WEB_LLM_MODEL_ID))

// `extra_body.enable_thinking` is only honoured for the Qwen3 family. Qwen3.5
// and Qwen2.5 are separate families that share a prefix, which is exactly the
// mistake a looser check would make.
assert.ok(modelSupportsThinking('Qwen3-1.7B-q4f16_1-MLC'))
assert.ok(modelSupportsThinking('qwen3-0.6b-q4f16_1-mlc'))
assert.ok(modelSupportsThinking('  Qwen3-4B-q4f16_1-MLC  '))
assert.equal(modelSupportsThinking('Qwen3.5-2B-q4f16_1-MLC'), false)
assert.equal(modelSupportsThinking('Qwen2.5-3B-Instruct-q4f16_1-MLC'), false)
assert.equal(modelSupportsThinking('Llama-3.2-1B-Instruct-q4f16_1-MLC'), false)
assert.equal(modelSupportsThinking(''), false)

// Being tool-tuned is a hint about how well a model will guess, never a
// permission to call tools: `ChatWebLlm` puts the schemas in the system prompt
// and constrains the decode itself, and neither step consults a model list. The
// lookup is exact rather than by family so the claim stays the same one web-llm
// makes — `q4f32_1` variants of these families exist and only some are listed.
assert.deepEqual(TOOL_TUNED_WEB_LLM_MODEL_IDS, [
  'Hermes-2-Pro-Mistral-7B-q4f16_1-MLC',
  'Hermes-3-Llama-3.1-8B-q4f16_1-MLC',
  'Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC',
  'Hermes-3-Llama-3.1-8B-q4f32_1-MLC',
  'Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC'
])

for (const tuned of TOOL_TUNED_WEB_LLM_MODEL_IDS) {
  assert.ok(modelIsToolTuned(tuned), `${tuned} was fine-tuned on a tool-call format`)
}

assert.ok(modelIsToolTuned('  Hermes-3-Llama-3.1-8B-q4f16_1-MLC  '))
assert.equal(modelIsToolTuned('Hermes-2-Pro-Mistral-7B-q4f32_1-MLC'), false)
assert.equal(modelIsToolTuned('hermes-3-llama-3.1-8b-q4f16_1-mlc'), false)
assert.equal(modelIsToolTuned(''), false)

// The recommendation is deliberately not tool-tuned, and the agent runs on it
// anyway. A test that expected otherwise would be re-imposing the gate that
// putting the agent behind a 4 GB download was the bug.
assert.equal(modelIsToolTuned(RECOMMENDED_WEB_LLM_MODEL_ID), false)

// The tool-tuned models the panel offers still have to be curated ones, or a
// recommendation to switch would name a model the menu cannot select.
for (const curated of CURATED_WEB_LLM_MODEL_IDS.filter(modelIsToolTuned)) {
  assert.ok(TOOL_TUNED_WEB_LLM_MODEL_IDS.includes(curated))
}
assert.deepEqual(CURATED_WEB_LLM_MODEL_IDS.filter(modelIsToolTuned), [
  'Hermes-2-Pro-Mistral-7B-q4f16_1-MLC',
  'Hermes-3-Llama-3.1-8B-q4f16_1-MLC'
])

// VRAM arrives in megabytes with a fraction. Gigabytes get one decimal because
// that is the difference a user cares about; megabytes get none.
assert.equal(formatModelVram(2036.66), '2.0 GB')
assert.equal(formatModelVram(3431.59), '3.4 GB')
assert.equal(formatModelVram(1403.34), '1.4 GB')
assert.equal(formatModelVram(879.04), '879 MB')
assert.equal(formatModelVram(1024), '1.0 GB')
assert.equal(formatModelVram(1023.4), '1023 MB')

// A record that says nothing about its size must not claim to be free.
assert.equal(formatModelVram(0), 'Unknown')
assert.equal(formatModelVram(-1), 'Unknown')
assert.equal(formatModelVram(Number.NaN), 'Unknown')
assert.equal(formatModelVram(Number.POSITIVE_INFINITY), 'Unknown')

const PREBUILT: WebLlmModelRecordLike[] = [
  // Deliberately out of curated order, and with unrelated records mixed in:
  // this is what `prebuiltAppConfig.model_list` looks like.
  { model_id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', vram_required_MB: 2263.69, low_resource_required: true, overrides: { context_window_size: 4096 } },
  { model_id: 'snowflake-arctic-embed-m-q0f32-MLC-b32', vram_required_MB: 1300, model_type: 1 },
  { model_id: 'Qwen3-1.7B-q4f16_1-MLC', vram_required_MB: 2036.66, low_resource_required: true, overrides: { context_window_size: 4096 } },
  { model_id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', vram_required_MB: 3672.07, low_resource_required: false, overrides: { context_window_size: 4096 } },
  { model_id: 'Qwen3-0.6B-q4f16_1-MLC', vram_required_MB: 1403.34, low_resource_required: true, overrides: { context_window_size: 4096 } },
  { model_id: 'Qwen3-4B-q4f16_1-MLC', vram_required_MB: 3431.59, low_resource_required: true, overrides: { context_window_size: 4096 } },
  { model_id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', vram_required_MB: 879.04, low_resource_required: true, overrides: { context_window_size: 4096 } },
  { model_id: 'Hermes-2-Pro-Mistral-7B-q4f16_1-MLC', vram_required_MB: 4033.28, low_resource_required: false, overrides: { context_window_size: 4096 } },
  { model_id: 'Hermes-3-Llama-3.1-8B-q4f16_1-MLC', vram_required_MB: 4876.13, low_resource_required: false, overrides: { context_window_size: 4096 } }
]

const catalog = buildWebLlmCatalog(PREBUILT)

// Curated order wins over the order web-llm happens to list them in, and
// nothing outside the curated list gets through.
assert.deepEqual(catalog.map(model => model.id), CURATED_WEB_LLM_MODEL_IDS)

const recommended = catalog[0]
assert.deepEqual(recommended, {
  id: 'Qwen3-1.7B-q4f16_1-MLC',
  label: 'Qwen3 1.7B',
  vramMb: 2036.66,
  vramLabel: '2.0 GB',
  lowResource: true,
  contextWindowSize: 4096,
  supportsThinking: true,
  toolCallingQuality: 'general',
  recommended: true
})

// Exactly one entry may claim to be the recommendation.
assert.equal(catalog.filter(model => model.recommended).length, 1)
assert.deepEqual(
  catalog.filter(model => model.supportsThinking).map(model => model.id),
  ['Qwen3-1.7B-q4f16_1-MLC', 'Qwen3-0.6B-q4f16_1-MLC', 'Qwen3-4B-q4f16_1-MLC']
)

// The two tool-tuned entries come last: they are an upgrade for somebody whose
// model keeps picking the wrong tool, not a prerequisite for the agent.
assert.deepEqual(
  catalog.filter(model => model.toolCallingQuality === 'tuned').map(model => model.id),
  ['Hermes-2-Pro-Mistral-7B-q4f16_1-MLC', 'Hermes-3-Llama-3.1-8B-q4f16_1-MLC']
)

// Every other entry says `'general'` rather than saying nothing, because the
// panel has a sentence to show for both and neither of them is "cannot".
assert.equal(catalog.every(model => model.toolCallingQuality === 'tuned' || model.toolCallingQuality === 'general'), true)
assert.equal(catalog.filter(model => model.toolCallingQuality === 'general').length, 6)
assert.equal(catalog.at(-1)?.id, 'Hermes-3-Llama-3.1-8B-q4f16_1-MLC')
assert.equal(catalog.find(model => model.id === 'Hermes-2-Pro-Mistral-7B-q4f16_1-MLC')?.vramLabel, '3.9 GB')
assert.equal(catalog.find(model => model.id === 'Phi-3.5-mini-instruct-q4f16_1-MLC')?.lowResource, false)

// A web-llm upgrade that retires a build must degrade to the models that are
// still there, not crash and not invent an entry.
const partial = buildWebLlmCatalog(
  PREBUILT.filter(record => record.model_id !== 'Qwen3-1.7B-q4f16_1-MLC')
)
assert.deepEqual(partial.map(model => model.id), [
  'Qwen3-0.6B-q4f16_1-MLC',
  'Qwen3-4B-q4f16_1-MLC',
  'Llama-3.2-1B-Instruct-q4f16_1-MLC',
  'Llama-3.2-3B-Instruct-q4f16_1-MLC',
  'Phi-3.5-mini-instruct-q4f16_1-MLC',
  'Hermes-2-Pro-Mistral-7B-q4f16_1-MLC',
  'Hermes-3-Llama-3.1-8B-q4f16_1-MLC'
])
assert.equal(partial.some(model => model.recommended), false)

// An empty list is what a broken import looks like, and it must not throw.
assert.deepEqual(buildWebLlmCatalog([]), [])

// A record missing the optional fields is still offerable — it just cannot
// promise anything about size or context.
const bare = buildWebLlmCatalog([{ model_id: 'Qwen3-0.6B-q4f16_1-MLC' }])
assert.equal(bare.length, 1)
assert.equal(bare[0]?.vramMb, 0)
assert.equal(bare[0]?.vramLabel, 'Unknown')
assert.equal(bare[0]?.lowResource, false)
assert.equal(bare[0]?.contextWindowSize, 0)
assert.equal(bare[0]?.supportsThinking, true)
assert.equal(bare[0]?.toolCallingQuality, 'general')

// A sliding-window model reports -1 for the fixed window and the real number
// beside it, so reading only the first field would lose it.
const sliding = buildWebLlmCatalog([{
  model_id: 'Qwen3-4B-q4f16_1-MLC',
  overrides: { context_window_size: -1, sliding_window_size: 4096 }
}])
assert.equal(sliding[0]?.contextWindowSize, 4096)

const nulled = buildWebLlmCatalog([{
  model_id: 'Qwen3-4B-q4f16_1-MLC',
  overrides: { context_window_size: null, sliding_window_size: null }
}])
assert.equal(nulled[0]?.contextWindowSize, 0)

// An id repurposed for an embedding or vision model would load and then answer
// nothing, so the record has to agree it is an LLM.
assert.deepEqual(
  buildWebLlmCatalog([{ model_id: 'Qwen3-1.7B-q4f16_1-MLC', model_type: 1 }]),
  []
)
assert.deepEqual(
  buildWebLlmCatalog([{ model_id: 'Qwen3-1.7B-q4f16_1-MLC', model_type: 2 }]),
  []
)
assert.equal(buildWebLlmCatalog([{ model_id: 'Qwen3-1.7B-q4f16_1-MLC', model_type: 0 }]).length, 1)

// A duplicated id — two builds registered under one name — must still yield one
// menu entry.
assert.equal(
  buildWebLlmCatalog([
    { model_id: 'Qwen3-1.7B-q4f16_1-MLC', vram_required_MB: 2036.66 },
    { model_id: 'Qwen3-1.7B-q4f16_1-MLC', vram_required_MB: 9999 }
  ]).length,
  1
)

console.log('web-llm-catalog.test.ts ok')
