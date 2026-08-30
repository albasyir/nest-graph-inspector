import type {
  ChatCompletionMessageParam,
  InitProgressReport,
  MLCEngineInterface
} from '@mlc-ai/web-llm'
import { toWebLlmTemplateMessages } from '~/utils/web-llm-boundary'
import type {
  WebLlmChatMessage,
  WebLlmStreamDelta,
  WebLlmStreamOptions,
  WebLlmStreamer
} from '~/utils/web-llm-boundary'
import type { WebLlmCatalogModel } from '~/utils/web-llm-catalog'
import {
  CURATED_WEB_LLM_MODEL_IDS,
  buildWebLlmCatalog,
  modelSupportsThinking
} from '~/utils/web-llm-catalog'
import { formatWebLlmProgress } from '~/utils/web-llm-progress'

/**
 * The chat model, running in this browser on this machine's GPU.
 *
 * The whole model lives on the client: weights are fetched from HuggingFace by
 * the browser, kept in the Cache API, and decoded on the local GPU through
 * WebGPU. Nothing about the graph leaves the machine and there is no server
 * component to reach — which is the point, since the graph being discussed is
 * a description of the developer's own application.
 *
 * This is the only surface a chat model talks to. Everything about
 * `@mlc-ai/web-llm` — that it must not be imported until the browser asks for
 * it, that the engine lives on a worker thread, that a model has to be resident
 * before it can answer — is settled here rather than in a component or in a
 * model class.
 *
 * Tool calling is the one thing deliberately *not* settled here; `streamChat`
 * says why.
 */

export type WebLlmErrorKind = 'unsupported' | 'catalog' | 'load' | 'generate'

/** A failure the panel can tell apart from a bug, and word for a person. */
export class WebLlmError extends Error {
  readonly kind: WebLlmErrorKind

  constructor(kind: WebLlmErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WebLlmError'
    this.kind = kind
  }
}

/** Enough progress lines to show what stage a long download is at, not a log. */
const PROGRESS_EVENT_LIMIT = 6

const DEFAULT_TEMPERATURE = 0.2

type WebLlmModule = typeof import('@mlc-ai/web-llm')

let webLlmModulePromise: Promise<WebLlmModule> | undefined

/**
 * Loads `@mlc-ai/web-llm`, once per tab.
 *
 * Never a top-level import: the homepage is prerendered, `/view` is rendered on
 * the server, and this library reaches for browser globals — so a static import
 * would put it in the server bundle and evaluate it where none of them exist.
 * The promise is cached rather than the module, so several callers racing on
 * first use share one fetch of a bundle this large instead of each starting
 * their own.
 */
function loadWebLlm(): Promise<WebLlmModule> {
  webLlmModulePromise ??= import('@mlc-ai/web-llm').catch((cause: unknown) => {
    // A failed chunk fetch must not be remembered as the answer. The panel's
    // refresh button exists to retry exactly this case — a redeploy that
    // invalidated the hashed chunk, or a connection that dropped — and a cached
    // rejection would make every retry fail without touching the network again.
    webLlmModulePromise = undefined

    throw cause
  })

  return webLlmModulePromise
}

function readErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) {
    return cause.message
  }

  return typeof cause === 'string' && cause.trim() ? cause : 'The browser gave no reason.'
}

/**
 * web-llm's request type is a discriminated union of one interface per role, and
 * a message whose `role` is still a union cannot be narrowed into one arm of it.
 * Spelling the roles out is what keeps this honest instead of a cast.
 *
 * `toWebLlmTemplateMessages` has already folded the two structured fields — an
 * assistant turn's `tool_calls`, and the `tool` role — back into text, so what
 * arrives here is three roles every chat template understands. That is not
 * tidiness: web-llm throws `Role is not supported: tool` for any model whose
 * template does not declare the role, which is four of the eight curated ones
 * including the recommended default.
 */
function toRequestMessages(messages: readonly WebLlmChatMessage[]): ChatCompletionMessageParam[] {
  return toWebLlmTemplateMessages(messages).map((message) => {
    if (message.role === 'system') {
      return { role: 'system', content: message.content }
    }

    if (message.role === 'assistant') {
      return { role: 'assistant', content: message.content }
    }

    return { role: 'user', content: message.content }
  })
}

export function useWebLlmEngine() {
  const isSupported = ref(false)
  const supportReason = ref('')
  const isCheckingSupport = ref(false)
  const catalog = ref<WebLlmCatalogModel[]>([])
  const cachedModelIds = ref<string[]>([])
  const isLoadingCatalog = ref(false)
  const hasLoadedCatalog = ref(false)
  const loadedModelId = ref('')
  const isPreparingModel = ref(false)
  const preparingModelId = ref('')
  const progressPercent = ref(0)
  const progressLabel = ref('')
  const progressEvents = ref<string[]>([])
  const isGenerating = ref(false)
  const error = ref('')

  // Not reactive state: the panel never renders the engine or the worker, and
  // making them refs would have Vue walk a WebGPU-backed object graph on every
  // update.
  let worker: Worker | undefined
  let engine: MLCEngineInterface | undefined

  /**
   * Whether this browser can run a model at all.
   *
   * Cannot be a `computed`: the real answer needs an `await` — a browser can
   * expose `navigator.gpu` and still refuse to hand out an adapter — and it can
   * only be asked in the browser at all, so the panel calls this once it is
   * mounted rather than deriving it.
   */
  async function checkSupport(): Promise<boolean> {
    if (!import.meta.client) {
      return false
    }

    isCheckingSupport.value = true

    try {
      if (!('gpu' in navigator)) {
        isSupported.value = false
        supportReason.value = 'This browser has no WebGPU, so a model cannot run in it. Chrome or Edge 113 and later, or Safari 18 and later, can run the chat.'

        return false
      }

      // Present but unusable is the common case on a desktop: hardware
      // acceleration switched off, a blocklisted driver, or a headless session.
      // It needs its own sentence, because "update your browser" is useless
      // advice for it.
      const adapter = await navigator.gpu.requestAdapter()

      if (!adapter) {
        isSupported.value = false
        supportReason.value = 'This browser has WebGPU but would not grant a GPU adapter. That usually means hardware acceleration is switched off, or the graphics driver is blocked.'

        return false
      }

      isSupported.value = true
      supportReason.value = ''

      return true
    } catch (cause) {
      isSupported.value = false
      supportReason.value = `WebGPU could not be started in this browser. ${readErrorMessage(cause)}`

      return false
    } finally {
      isCheckingSupport.value = false
    }
  }

  async function refreshCachedModelIds(): Promise<void> {
    const webLlm = await loadWebLlm()

    const cacheStates = await Promise.all(
      CURATED_WEB_LLM_MODEL_IDS.map(async modelId => ({
        modelId,
        // A model the browser has never seen is the normal answer here. A
        // storage backend that refuses the question at all must not take the
        // rest of the catalog down with it.
        isCached: await webLlm.hasModelInCache(modelId).catch(() => false)
      }))
    )

    cachedModelIds.value = cacheStates
      .filter(state => state.isCached)
      .map(state => state.modelId)
  }

  /**
   * Reads the model list web-llm ships and asks which of them this browser has
   * already downloaded.
   *
   * Failure is reported through `error` rather than thrown: the panel calls this
   * as it mounts, and a rejection there would abandon the rest of the panel's
   * own setup. `hasLoadedCatalog` staying false is what tells the UI to show the
   * failure instead of an empty menu.
   */
  async function refreshCatalog(): Promise<void> {
    if (!import.meta.client) {
      return
    }

    isLoadingCatalog.value = true

    try {
      const webLlm = await loadWebLlm()

      catalog.value = buildWebLlmCatalog(webLlm.prebuiltAppConfig.model_list)
      await refreshCachedModelIds()
      hasLoadedCatalog.value = true
      error.value = ''
    } catch (cause) {
      catalog.value = []
      cachedModelIds.value = []
      hasLoadedCatalog.value = false
      error.value = `The list of models could not be read. ${readErrorMessage(cause)}`
    } finally {
      isLoadingCatalog.value = false
    }
  }

  function handleInitProgress(report: InitProgressReport): void {
    const progress = formatWebLlmProgress(report)

    progressPercent.value = progress.percent
    progressLabel.value = progress.label

    // The stage rather than the sentence: web-llm writes the shard index, the
    // megabytes fetched and the seconds elapsed into every report, so no two
    // sentences are ever equal and a list of them is the same stage over and
    // over with a rolling counter. The stage name is what makes this a history
    // of what the load has been through.
    if (progressEvents.value.at(-1) !== progress.stage) {
      progressEvents.value = [
        ...progressEvents.value.slice(-(PROGRESS_EVENT_LIMIT - 1)),
        progress.stage
      ]
    }
  }

  /**
   * Makes a model resident, downloading it the first time.
   *
   * The first call builds the worker and the engine; later calls for a different
   * model reload the weights inside the engine that already exists, because the
   * worker's WebGPU device is the expensive part and two of them would compete
   * for the same VRAM.
   *
   * Reports failure twice over — through `error`, for a panel that is only
   * rendering state, and by throwing, for the caller that was waiting to send a
   * message.
   */
  async function prepareModel(modelId: string): Promise<void> {
    if (!import.meta.client || !modelId) {
      return
    }

    if (engine && loadedModelId.value === modelId) {
      return
    }

    if (isPreparingModel.value) {
      const message = `${preparingModelId.value || 'A model'} is still loading. Wait for it to finish before switching models.`
      error.value = message

      throw new WebLlmError('load', message)
    }

    isPreparingModel.value = true
    preparingModelId.value = modelId
    progressPercent.value = 0
    progressLabel.value = 'Preparing model'
    progressEvents.value = []
    error.value = ''

    try {
      const webLlm = await loadWebLlm()

      if (engine) {
        // The progress callback was registered when the engine was created, so
        // a reload reports through the same one.
        await engine.reload(modelId)
      } else {
        // Vite rewrites this URL to the emitted worker chunk, which is also
        // what makes it survive the site's GitHub Pages base path — a
        // hand-built path would not. The specifier is relative rather than the
        // `~` alias because only the relative form is resolved by plain path
        // arithmetic, with no alias resolution to go wrong.
        const nextWorker = new Worker(new URL('../workers/web-llm.worker.ts', import.meta.url), { type: 'module' })

        try {
          engine = await webLlm.CreateWebWorkerMLCEngine(nextWorker, modelId, {
            initProgressCallback: handleInitProgress
          })
        } catch (cause) {
          // A worker that failed to build an engine still has a thread and, by
          // this point, usually a WebGPU device. Dropping the reference does
          // not end either one, and the next attempt would build a second
          // worker to compete with it for the same VRAM — which is exactly the
          // machine where the first load ran out of it.
          nextWorker.terminate()

          throw cause
        }

        // Published only now, so `dispose` can never be left holding a worker
        // whose engine does not exist.
        worker = nextWorker
      }

      loadedModelId.value = modelId
      await refreshCachedModelIds()
    } catch (cause) {
      // A failed reload leaves the engine holding nothing: web-llm unloads the
      // old weights before it fetches the new ones.
      loadedModelId.value = ''
      progressLabel.value = 'The model could not be loaded'

      const message = `${modelId} could not be loaded. ${readErrorMessage(cause)}`
      error.value = message

      throw new WebLlmError('load', message, { cause })
    } finally {
      isPreparingModel.value = false
      preparingModelId.value = ''
    }
  }

  /**
   * Answers a conversation, handing the caller each delta as it decodes.
   *
   * The deltas are raw: reasoning models write their thinking into the same
   * content stream wrapped in `<think>`, because web-llm's chunks carry no
   * separate reasoning field, so it is the caller that splits them —
   * `parseStreamingAssistantReply` is there for exactly this.
   *
   * Note what this deliberately never does: put `tools` on the request. web-llm
   * looks the resident model up in its own `functionCallingModelIds` before it
   * reads anything else about a request that carries them, and throws
   * `UnsupportedModelIdError` for everything outside that list of five Hermes
   * builds — 4 GB of VRAM and upward, against the 2 GB the recommended model
   * needs. Reading what it does once past that check is what makes the list not
   * worth paying for: it interpolates the tool definitions into a Hermes system
   * prompt, prepends it, forces `response_format` to a JSON schema, and parses
   * the answer back out. That is prompt text plus constrained decoding, and a
   * caller can do both for itself through `messages` and `responseFormat` — on
   * any model in the catalog, which is the point. The allowlist is a statement
   * about which models were fine-tuned to word a tool call well, not about
   * which ones can emit one.
   */
  async function streamChat(
    modelId: string,
    messages: readonly WebLlmChatMessage[],
    options: WebLlmStreamOptions,
    onDelta: (delta: WebLlmStreamDelta) => void
  ): Promise<void> {
    if (!import.meta.client) {
      return
    }

    if (!engine || loadedModelId.value !== modelId) {
      await prepareModel(modelId)
    }

    const activeEngine = engine

    if (!activeEngine) {
      throw new WebLlmError('generate', 'No model is loaded, so there is nothing to answer with.')
    }

    isGenerating.value = true

    try {
      const stream = await activeEngine.chat.completions.create({
        messages: toRequestMessages(messages),
        stream: true,
        stream_options: { include_usage: true },
        temperature: options.temperature ?? DEFAULT_TEMPERATURE,
        // web-llm only honours this for the Qwen3 family, and a template that
        // was not trained on it is better left alone. Note that switching
        // thinking off does not remove the tags: web-llm prepends an empty
        // `<think></think>` pair instead, which is another reason the caller
        // parses the stream.
        ...(!options.enableThinking && modelSupportsThinking(modelId)
          ? { extra_body: { enable_thinking: false } }
          : {}),
        // Absent rather than `{ type: 'text' }` when the caller wants no
        // constraint: web-llm branches on the field existing, and an explicit
        // format sends the request down the grammar-compiling path for a turn
        // that only wanted prose.
        ...(options.responseFormat ? { response_format: options.responseFormat } : {})
      })

      // How the panel abandons a model that thinks for too long: `onDelta`
      // throws. That must not become a `break`, because breaking out of a
      // `for await` only closes the generator on this side. The one inside the
      // worker stays suspended mid-decode, and it is the only thing that ever
      // releases the per-model lock web-llm took before the first chunk — so
      // the next request for this model would wait on a lock nobody can free
      // and never settle. Interrupting and then draining lets the worker
      // resume, see the signal, stop, and release the lock, at the cost of two
      // or three more chunks; the failure is rethrown once the stream is over.
      let deltaFailure: unknown
      let hasDeltaFailed = false

      for await (const chunk of stream) {
        if (hasDeltaFailed) {
          continue
        }

        const delta = chunk.choices[0]?.delta

        if (!delta) {
          continue
        }

        const content = delta.content ?? ''
        const toolCalls = delta.tool_calls ?? []

        // A chunk that carries tool calls need not carry any text with them, so
        // skipping on empty content alone could drop the one chunk an agent
        // loop is waiting for. Nothing on this engine reports them today — see
        // above, the tool path is never asked for — but the loop reads the
        // delta rather than assuming what a provider puts in it.
        if (!content && toolCalls.length === 0) {
          continue
        }

        try {
          onDelta({
            ...(content ? { content } : {}),
            ...(toolCalls.length ? { toolCalls } : {})
          })
        } catch (cause) {
          deltaFailure = cause
          hasDeltaFailed = true
          interrupt()
        }
      }

      if (hasDeltaFailed) {
        throw deltaFailure
      }
    } catch (cause) {
      // A stream that failed on its own already released the lock in web-llm's
      // own error handling, so this only has to stop a generation that is
      // somehow still running. The original error is rethrown untouched,
      // because the caller recognises its own error type and would not
      // recognise a wrapper.
      interrupt()

      throw cause
    } finally {
      isGenerating.value = false
    }
  }

  /** Stops whatever is decoding. Safe when nothing is. */
  function interrupt(): void {
    if (!engine) {
      return
    }

    try {
      engine.interruptGenerate()
    } catch {
      // Nothing was generating, so there was nothing to interrupt.
    }
  }

  /** Removes a model's weights from this browser, freeing the disk they held. */
  async function deleteModel(modelId: string): Promise<void> {
    if (!import.meta.client || !modelId) {
      return
    }

    try {
      const webLlm = await loadWebLlm()

      // A resident model has to leave the engine before its files leave the
      // cache, or the next answer decodes against weights that are half gone.
      if (loadedModelId.value === modelId) {
        await engine?.unload()
        loadedModelId.value = ''
      }

      await webLlm.deleteModelAllInfoInCache(modelId)
      await refreshCachedModelIds()
    } catch (cause) {
      error.value = `${modelId} could not be removed from this browser. ${readErrorMessage(cause)}`

      throw cause
    }
  }

  /** Gives the GPU and the worker thread back. Called when the panel goes away. */
  async function dispose(): Promise<void> {
    const disposingEngine = engine
    const disposingWorker = worker

    engine = undefined
    worker = undefined
    loadedModelId.value = ''
    isGenerating.value = false
    isPreparingModel.value = false
    preparingModelId.value = ''

    try {
      // Unload before terminating: the worker owns the WebGPU device, and
      // killing the thread without releasing it leaks that allocation for as
      // long as the tab lives.
      await disposingEngine?.unload()
    } catch {
      // A worker that has already gone cannot unload, and terminating it is
      // what actually matters here.
    }

    disposingWorker?.terminate()
  }

  return {
    isSupported,
    supportReason,
    isCheckingSupport,
    catalog,
    cachedModelIds,
    isLoadingCatalog,
    hasLoadedCatalog,
    loadedModelId,
    isPreparingModel,
    preparingModelId,
    progressPercent,
    progressLabel,
    progressEvents,
    isGenerating,
    error,
    checkSupport,
    refreshCatalog,
    prepareModel,
    // Written through the streamer contract rather than passed along bare, so a
    // signature that drifts from what a chat model binds to is a compile error
    // here instead of a mismatch a browser finds later.
    streamChat: streamChat satisfies WebLlmStreamer['streamChat'],
    interrupt: interrupt satisfies WebLlmStreamer['interrupt'],
    deleteModel,
    dispose
  }
}
