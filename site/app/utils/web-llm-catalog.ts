/**
 * The in-browser models the chat panel offers.
 *
 * web-llm ships well over a hundred prebuilt records, most of them quantization
 * variants nobody reading a dependency graph wants to choose between, and many
 * of them far too large for the GPU a laptop has. This narrows that list to a
 * handful that fit, in the order the panel offers them, and turns web-llm's
 * records into something a select menu can render.
 *
 * Deliberately free of browser APIs and of any import from `@mlc-ai/web-llm`:
 * the module runs in the site's plain `node:test`-less assertion scripts, and
 * the library itself only loads inside the browser.
 */

/** The shape of a web-llm `ModelRecord` this module needs. Structural on purpose so it stays testable. */
export type WebLlmModelRecordLike = {
  model_id: string
  vram_required_MB?: number
  low_resource_required?: boolean
  model_type?: number
  overrides?: { context_window_size?: number | null, sliding_window_size?: number | null }
}

export type WebLlmCatalogModel = {
  /** web-llm's own `model_id`, which is what `prepareModel` and `reload` take. */
  id: string
  label: string
  /** 0 when the record does not say how much VRAM the model needs. */
  vramMb: number
  vramLabel: string
  lowResource: boolean
  /** 0 when the record does not say what the model can hold. */
  contextWindowSize: number
  supportsThinking: boolean
  /** How reliably the model picks the right tool — see `WebLlmToolCallingQuality`. */
  toolCallingQuality: WebLlmToolCallingQuality
  recommended: boolean
}

/**
 * How well a model is expected to use tools — never whether it can.
 *
 * Every model here can call a tool, because the chat does not use web-llm's
 * built-in function calling. `ChatWebLlm` puts the tool schemas in the system
 * prompt itself and constrains the decode with `response_format`, and neither
 * of those is looked up against a model list. What a model cannot be given is
 * *judgement*: a constrained decode guarantees the call is well formed, not
 * that it was the right call to make.
 *
 * `'tuned'` marks the models fine-tuned on a tool-call format, which pick the
 * right tool more often and give up less. `'general'` is everything else, and
 * it is a perfectly usable answer — the recommended 2 GB model is `'general'`
 * and runs the agent end to end. Treat this as a sentence the panel can show,
 * never as a condition to branch the agent on.
 */
export type WebLlmToolCallingQuality = 'tuned' | 'general'

/** `ModelType.LLM`, the only kind of model a chat panel can talk to. */
const WEB_LLM_MODEL_TYPE_LLM = 0

export const RECOMMENDED_WEB_LLM_MODEL_ID = 'Qwen3-1.7B-q4f16_1-MLC'

/**
 * The models that were fine-tuned on a tool-call format.
 *
 * These are the ids in web-llm's own exported `functionCallingModelIds`. In
 * web-llm that array is a gate — pass `tools` on a request for anything else
 * and it throws `UnsupportedModelIdError` before reading the rest. Here it is
 * only a quality hint, because the chat never passes `tools`: web-llm's
 * built-in path is itself nothing but a system prompt plus a JSON grammar, and
 * `ChatWebLlm` does that part directly, which works on every model. So nothing
 * may be gated on this list. It answers "which of these will guess best?", and
 * the honest answer for the rest is "less often, but it still works".
 *
 * Copied rather than imported on purpose: this module is deliberately free of
 * `@mlc-ai/web-llm` so the site's plain node test scripts can import it, and
 * pulling the package in for one array would put a browser-only library into
 * them. The cost of a copy is only a stale hint, which is the cheapest thing
 * here to get wrong.
 */
export const TOOL_TUNED_WEB_LLM_MODEL_IDS: readonly string[] = [
  'Hermes-2-Pro-Mistral-7B-q4f16_1-MLC',
  'Hermes-3-Llama-3.1-8B-q4f16_1-MLC',
  'Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC',
  'Hermes-3-Llama-3.1-8B-q4f32_1-MLC',
  'Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC'
]

/**
 * The curated models and the names the panel shows for them.
 *
 * Ordered by what to reach for first rather than by size: the reasoning models
 * come first because a dependency-graph question is a reasoning question, the
 * plain instruction-tuned models follow as the fallback for a machine that
 * cannot spare the VRAM, and the two tool-tuned Hermes builds come last
 * because they are the largest thing here by some margin — around 4 GB of VRAM
 * against the 2 GB the recommendation needs.
 *
 * Last, not required. The agent runs on the recommended model; a Hermes build
 * is an upgrade someone can choose when a 1.7B model keeps picking the wrong
 * tool, and paying four gigabytes for that by default would be a bad trade.
 * Every id is a `q4f16_1` build, which is the quantization that keeps these
 * models inside a few gigabytes.
 */
const CURATED_WEB_LLM_MODELS: readonly { id: string, label: string }[] = [
  { id: RECOMMENDED_WEB_LLM_MODEL_ID, label: 'Qwen3 1.7B' },
  { id: 'Qwen3-0.6B-q4f16_1-MLC', label: 'Qwen3 0.6B' },
  { id: 'Qwen3-4B-q4f16_1-MLC', label: 'Qwen3 4B' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B' },
  { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 3B' },
  { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', label: 'Phi-3.5 Mini' },
  { id: 'Hermes-2-Pro-Mistral-7B-q4f16_1-MLC', label: 'Hermes 2 Pro Mistral 7B' },
  { id: 'Hermes-3-Llama-3.1-8B-q4f16_1-MLC', label: 'Hermes 3 Llama 3.1 8B' }
]

export const CURATED_WEB_LLM_MODEL_IDS: readonly string[] = CURATED_WEB_LLM_MODELS.map(model => model.id)

/**
 * Whether a model reasons inside `<think>` tags, and so whether
 * `extra_body.enable_thinking` means anything to it.
 *
 * web-llm only honours that flag for the Qwen3 family. Sending it to anything
 * else is at best ignored, so the family is checked rather than assumed — and
 * `Qwen3.5` and `Qwen2.5` are separate families that must not match.
 */
export function modelSupportsThinking(modelId: string): boolean {
  return /^qwen3-/i.test(modelId.trim())
}

/**
 * Whether a model was fine-tuned on a tool-call format.
 *
 * Deliberately not named for a capability, and deliberately not a question any
 * caller has to ask before offering tools: a `false` here means "this one will
 * guess less well", never "do not try". Matched exactly rather than by family
 * so the answer stays the same claim web-llm's own list makes —
 * `Hermes-2-Pro-Mistral-7B-q4f32_1-MLC` is a real build of a listed family that
 * is not itself listed. Surrounding whitespace is forgiven since an id can
 * arrive from a stored preference.
 */
export function modelIsToolTuned(modelId: string): boolean {
  return TOOL_TUNED_WEB_LLM_MODEL_IDS.includes(modelId.trim())
}

/**
 * How much GPU memory a model needs while it runs, as the panel shows it.
 *
 * This is `vram_required_MB`, which web-llm documents as the VRAM the model
 * needs — not how many bytes the browser downloads. The weights on the wire are
 * smaller, so presenting this as a download size both overstates the transfer
 * and hides the one number that decides whether the model can load at all.
 *
 * web-llm reports it in megabytes with a fraction nobody needs to read, and a
 * record that reports nothing at all has to say so rather than claim 0 MB.
 */
export function formatModelVram(megabytes: number): string {
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    return 'Unknown'
  }

  return megabytes >= 1024
    ? `${(megabytes / 1024).toFixed(1)} GB`
    : `${Math.round(megabytes)} MB`
}

function readPositiveNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function readContextWindowSize(overrides: WebLlmModelRecordLike['overrides']): number {
  // MLC's own convention: a model that decodes with a sliding window sets
  // `context_window_size` to -1 and puts the real number in
  // `sliding_window_size`. Reading only the first field would report "unknown"
  // for models that do say what they can hold.
  return readPositiveNumber(overrides?.context_window_size)
    || readPositiveNumber(overrides?.sliding_window_size)
}

/**
 * The curated models, in curated order, out of whatever web-llm's
 * `prebuiltAppConfig.model_list` currently holds.
 *
 * Ids the passed list does not contain are skipped rather than faked: a web-llm
 * upgrade is free to retire a build, and the panel showing the remaining models
 * is a much better outcome than offering one that can never load.
 */
export function buildWebLlmCatalog(records: readonly WebLlmModelRecordLike[]): WebLlmCatalogModel[] {
  const recordsById = new Map(records.map(record => [record.model_id, record]))

  return CURATED_WEB_LLM_MODELS.flatMap<WebLlmCatalogModel>(({ id, label }) => {
    const record = recordsById.get(id)

    if (!record) {
      return []
    }

    // An id that has been repurposed for an embedding or vision model would
    // load fine and then answer nothing, so the record has to agree it is an
    // LLM. Records that say nothing predate the field and are LLMs.
    if (record.model_type !== undefined && record.model_type !== WEB_LLM_MODEL_TYPE_LLM) {
      return []
    }

    const vramMb = readPositiveNumber(record.vram_required_MB)

    return [{
      id,
      label,
      vramMb,
      vramLabel: formatModelVram(vramMb),
      lowResource: record.low_resource_required === true,
      contextWindowSize: readContextWindowSize(record.overrides),
      supportsThinking: modelSupportsThinking(id),
      toolCallingQuality: modelIsToolTuned(id) ? 'tuned' : 'general',
      recommended: id === RECOMMENDED_WEB_LLM_MODEL_ID
    }]
  })
}
