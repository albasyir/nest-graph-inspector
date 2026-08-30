<script setup lang="ts">
import { WebLlmError, type WebLlmErrorKind } from '~/composables/useWebLlmEngine'
import { estimateGraphAgentPromptChars } from '~/utils/graph-agent-run'
import type { GraphAgentEvent, GraphAgentTurn } from '~/utils/graph-agent-run'
import type { WebLlmCatalogModel } from '~/utils/web-llm-catalog'
import type { WebLlmChatMessage } from '~/utils/web-llm-boundary'

/** One tool the agent called, and what it got back. */
type ChatToolStep = {
  id: string
  name: string
  args: string
  result?: string
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  reasoningStreaming?: boolean
  /** Only in agent mode: the lookups behind the answer, in the order they happened. */
  toolSteps?: ChatToolStep[]
  /** Said the loop gave up rather than the model finishing. */
  notice?: string
}

type ModelSelectItem = {
  label: string
  value?: string
  type?: 'label' | 'separator'
  icon?: string
  description?: string
  disabled?: boolean
}

const WEB_LLM_PROVIDER = 'web-llm'
const WEBGPU_SUPPORT_URL = 'https://caniuse.com/webgpu'
const WEBGPU_BROWSER_HINT = 'The model runs on this device\'s GPU, so the browser has to support WebGPU — Chrome or Edge 113+, or Safari 18+.'
const CHAT_TEMPERATURE = 0.2
const CONTEXT_WINDOW_OVERFLOW_MESSAGE = 'This conversation no longer fits the model\'s context window. Restart the chat to clear it, then ask again — every model here has the same 4096-token window, so a smaller one will not help.'
const THINKING_FALLBACK_CHAR_LIMIT = 3000
/**
 * The number of modules past which looking things up beats reading everything.
 *
 * Below it the whole graph fits the window with room to spare, and a single
 * streamed answer is both faster and less likely to go wrong than a loop. Above
 * it the excerpt starts losing modules, and an answer built from what happened
 * to survive the truncation is worse than one built from a lookup.
 */
const AGENT_MODE_MODULE_THRESHOLD = 12
const PREVIEW_MODEL_COUNT = 3
const DEFAULT_INITIAL_MESSAGE = 'Hi, I can help you inspect this NestJS graph. Ask me to trace a dependency, explain a module, or find where a provider is used.'
const DEFAULT_PREVIEW_REPLY = 'Hai!, load real project to chat with me!'

/**
 * Aborts a reasoning model that keeps thinking instead of answering.
 *
 * A small model running on a laptop GPU can spend minutes inside `<think>` and
 * never reach an answer. Throwing out of the delta handler stops that stream so
 * the same question can be asked again with thinking switched off.
 */
class ThinkingFallbackError extends Error {
  constructor() {
    super('The model kept thinking without producing answer content.')
  }
}

const props = withDefaults(defineProps<{
  active?: boolean
  preview?: boolean
  title?: string
  showHeader?: boolean
  showClose?: boolean
  contentClass?: string
  promptClass?: string
  initialMessage?: string
  previewReply?: string
  placeholder?: string
}>(), {
  active: true,
  preview: false,
  title: 'Ask AI',
  showHeader: true,
  showClose: true,
  contentClass: 'min-h-0 px-4 sm:px-5 py-4',
  promptClass: 'px-4 sm:px-5 py-4 bg-default',
  initialMessage: DEFAULT_INITIAL_MESSAGE,
  previewReply: DEFAULT_PREVIEW_REPLY,
  placeholder: undefined
})

const emit = defineEmits<{
  close: []
}>()

const prompt = ref('')
const isLoading = ref(false)
const modelError = ref('')
const hasCheckedSupport = ref(false)
const isProviderSelectOpen = ref(false)
const isModelSelectOpen = ref(false)
const isModelDownloadPopoverOpen = ref(false)
const modelDownloadElapsedMs = ref(0)
// There is one provider, so picking it is not a decision — and the probe that
// tells a visitor their browser cannot run a model hangs off this choice. Left
// empty, that probe would only run after they had already typed a question.
const selectedProvider = ref(WEB_LLM_PROVIDER)
const selectedModel = ref('')
/** How many turns the last message left out of the window, for the footer to own up to. */
const droppedHistoryCount = ref(0)
const previewProvider = ref(WEB_LLM_PROVIDER)
/**
 * Whether the reader has overruled the default answer mode.
 *
 * Kept apart from the mode itself so that the default can keep tracking the
 * graph — a viewer that switches from a three-module example to a hundred-module
 * application should change its mind — right up until someone says otherwise,
 * and never after.
 */
const agentModeOverride = ref<boolean | undefined>(undefined)

function createInitialAssistantMessage(): ChatMessage {
  return {
    role: 'assistant',
    content: props.initialMessage
  }
}

const messages = ref<ChatMessage[]>([createInitialAssistantMessage()])

const posthog = usePostHog()
const graphStore = useGraphInspectorStore()
const toast = useToast()

// Inference happens in this tab, so the composable owns the whole backend: the
// WebGPU probe, the model cache, the worker, and the stream.
const {
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
  error: engineError,
  checkSupport,
  refreshCatalog,
  prepareModel,
  streamChat,
  interrupt,
  deleteModel,
  dispose
} = useWebLlmEngine()

const { isRunning: isAgentRunning, runAgent } = useGraphAgent()

const providerItems = [
  {
    label: 'WebLLM',
    value: WEB_LLM_PROVIDER,
    // The icon set has no WebLLM brand glyph, and a name that does not resolve
    // renders as an empty box, so this uses a plain lucide icon.
    icon: 'i-lucide-cpu'
  }
]

/**
 * The models named on the marketing page.
 *
 * The catalog builder is pure, so synthetic records are enough to get the same
 * labels the live select shows — the preview must not touch the engine, which
 * would probe WebGPU and start a multi-gigabyte download for a visitor.
 */
const previewModelItems = buildWebLlmCatalog(
  CURATED_WEB_LLM_MODEL_IDS
    .slice(0, PREVIEW_MODEL_COUNT)
    .map(modelId => ({ model_id: modelId }))
).map(model => ({
  label: model.label,
  value: model.id,
  icon: 'i-lucide-brain',
  description: model.recommended ? 'Recommended' : 'Example'
}))

const previewModel = ref(previewModelItems[0]?.value || RECOMMENDED_WEB_LLM_MODEL_ID)

function describeModelId(modelId: string) {
  return catalog.value.find(model => model.id === modelId)?.label || modelId
}

function describeModelItem(model: WebLlmCatalogModel, cached: boolean) {
  const parts = [cached ? 'Downloaded' : 'Download']

  // web-llm's figure is the GPU memory the model needs while it runs, not the
  // bytes fetched. Showing it beside "Download" without saying so overstates
  // the transfer and, worse, hides the number that decides whether the model
  // will load on this machine at all.
  if (model.vramMb) {
    parts.push(`needs ${model.vramLabel} VRAM`)
  }

  if (model.recommended) {
    parts.push('Recommended')
  }

  return parts.join(' · ')
}

const cachedModels = computed(() => {
  return catalog.value.filter(model => cachedModelIds.value.includes(model.id))
})

const downloadableModels = computed(() => {
  return catalog.value.filter(model => !cachedModelIds.value.includes(model.id))
})

const modelItems = computed<ModelSelectItem[]>(() => {
  const downloadedModelItems: ModelSelectItem[] = cachedModels.value.map(model => ({
    label: model.label,
    value: model.id,
    icon: 'i-lucide-brain',
    description: describeModelItem(model, true),
    disabled: isPreparingModel.value
  }))
  const downloadableModelItems: ModelSelectItem[] = downloadableModels.value.map(model => ({
    label: model.label,
    value: model.id,
    icon: 'i-lucide-download',
    description: describeModelItem(model, false),
    disabled: isPreparingModel.value
  }))
  const items: ModelSelectItem[] = []

  if (downloadedModelItems.length) {
    items.push(
      { type: 'label', label: 'Downloaded models' },
      ...downloadedModelItems
    )
  }

  if (downloadableModelItems.length) {
    if (items.length) {
      items.push({ type: 'separator', label: 'Downloadable separator' })
    }

    items.push(
      { type: 'label', label: 'Downloadable models' },
      ...downloadableModelItems
    )
  }

  return items
})

const selectedProviderIcon = computed(() => {
  return providerItems.find(provider => provider.value === selectedProvider.value)?.icon
})

/**
 * Whether the chat has to stay off for the graph on screen.
 *
 * Only one thing keeps it off now: a graph emitted by an old library, which is
 * missing the detail the answers would be built from. A static fixture used to
 * be excluded too, because answering meant reaching the proxy that the
 * inspected application served — which a directory of files does not. The model
 * runs in this tab now, and the Markdown it reads is just another file sitting
 * beside `output.json`, so the bundled example answers like any other graph.
 */
const isChatUnavailable = computed(() => {
  return graphStore.graphData?.version == '1' || graphStore.graphData?.version == '0'
})

/** True only once the probe has actually run and failed. */
const isWebGpuUnavailable = computed(() => hasCheckedSupport.value && !isSupported.value)

const isStreaming = computed(() => isLoading.value || isGenerating.value || isAgentRunning.value)

const chatMessages = computed(() => messages.value.map((message, index) => {
  // A bubble with no text of its own still has something to show: the reasoning
  // as it streams, the lookups the agent made, or the sentence saying the loop
  // gave up. Any of them is reason enough to render the message.
  const shouldRenderReasoning = Boolean(
    message.reasoning
    || message.reasoningStreaming
    || message.toolSteps?.length
    || message.notice
  )

  return {
    id: `message-${index}`,
    role: message.role,
    content: message.content,
    parts: message.content || shouldRenderReasoning
      ? [{
          type: 'text' as const,
          text: message.content
        }]
      : [],
    metadata: {
      reasoning: message.reasoning,
      reasoningStreaming: message.reasoningStreaming,
      toolSteps: message.toolSteps,
      notice: message.notice
    }
  }
}))

const recommendedModel = computed(() => {
  return catalog.value.find(model => model.recommended)
    || catalog.value.find(model => model.id === RECOMMENDED_WEB_LLM_MODEL_ID)
})

/** The model the download button and the download toast act on. */
const downloadTargetModelId = computed(() => {
  return selectedModel.value || recommendedModel.value?.id || RECOMMENDED_WEB_LLM_MODEL_ID
})

const downloadTargetLabel = computed(() => describeModelId(downloadTargetModelId.value))

const shouldOfferRecommendedModel = computed(() => {
  return selectedProvider.value === WEB_LLM_PROVIDER
    && hasLoadedCatalog.value
    && !isLoadingCatalog.value
    && isSupported.value
    && !cachedModelIds.value.length
})

const promptPlaceholder = computed(() => {
  if (props.placeholder) {
    return props.placeholder
  }

  if (props.preview) {
    return 'Ask about your NestJS graph...'
  }

  return isChatUnavailable.value ? 'DISABLED: Upgrade the library to answer on this graph' : 'Ask about this graph...'
})

const isChatSubmitDisabled = computed(() => {
  if (props.preview) {
    return isLoading.value
  }

  return isChatUnavailable.value || isStreaming.value || isPreparingModel.value || isCheckingSupport.value
})
const isPromptDisabled = computed(() => isStreaming.value || isPreparingModel.value)
const isChatControlDisabled = computed(() => !props.preview && isChatUnavailable.value)

/**
 * The graph text the model will actually see.
 *
 * Every curated model has a 4096-token context window, so a large graph is
 * budgeted down before it is handed over. The panel reads the same context the
 * system prompt is built from to be able to say what was left out.
 */
const graphContext = computed(() => buildGraphContext(graphStore.graphMarkdown || ''))

const systemPrompt = computed(() => buildWebLlmSystemPrompt(graphStore.graphMarkdown || ''))

/**
 * How many modules the graph has, as the panel counts them.
 *
 * Straight off the JSON rather than off the Markdown, because the JSON is what
 * the tools answer from and the count is only used to decide which of the two
 * answering modes suits this graph.
 */
const graphModuleCount = computed(() => Object.keys(graphStore.graphData?.modules || {}).length)

/**
 * Which mode suits this graph, before anyone has said otherwise.
 *
 * Agent mode queries the graph instead of reading it, which is the only thing
 * that works once the graph stops fitting the context window — but it costs
 * several model turns for a question a small graph answers in one, so the
 * bundled three-module example stays on the plain path.
 */
const prefersAgentMode = computed(() => {
  return graphContext.value.truncated || graphModuleCount.value > AGENT_MODE_MODULE_THRESHOLD
})

const isAgentMode = computed({
  get: () => agentModeOverride.value ?? prefersAgentMode.value,
  set: (value: boolean) => {
    agentModeOverride.value = value
  }
})

/**
 * Whether the chosen model was fine-tuned on a tool-call format.
 *
 * A hint and never a gate. Every model here can call a tool: the chat writes
 * the tool schemas into the system prompt itself and constrains the decode with
 * a grammar, and neither of those is looked up against a model list. What a
 * fine-tune buys is judgement — picking the right tool, and giving up less —
 * which is worth saying out loud and worth nothing as a condition.
 */
const isSelectedModelToolTuned = computed(() => modelIsToolTuned(selectedModel.value))

const agentQualityHint = computed(() => {
  if (!isAgentMode.value || !selectedModel.value || isSelectedModelToolTuned.value) {
    return ''
  }

  return `${describeModelId(selectedModel.value)} can call these tools, but it was not fine-tuned to choose between them, so it may pick the wrong lookup and need another turn. The Hermes models in the list choose better, at 3.9 to 4.8 GB of VRAM against the 2.0 GB the recommendation needs.`
})

const graphTruncationHint = computed(() => {
  const omitted = graphContext.value.omittedModuleCount

  return omitted === 1
    ? 'This graph is larger than the model\'s context window, so 1 module was left out of what the model can see.'
    : `This graph is larger than the model's context window, so ${omitted} modules were left out of what the model can see.`
})

const droppedHistoryHint = computed(() => {
  const dropped = droppedHistoryCount.value

  return dropped === 1
    ? 'The conversation outgrew the model\'s context window, so the oldest message was left out of the last answer. Restart the chat to start clean.'
    : `The conversation outgrew the model's context window, so the ${dropped} oldest messages were left out of the last answer. Restart the chat to start clean.`
})

/**
 * The one line under the prompt.
 *
 * A missing GPU means nothing can be answered at all, so it outranks both notes
 * about something being trimmed. Between those two, the dropped turns are the
 * newer surprise — the graph excerpt has been the same since the panel opened.
 */
const footerHint = computed(() => {
  if (props.preview) {
    return ''
  }

  if (isWebGpuUnavailable.value) {
    const reason = modelError.value || supportReason.value

    return reason ? `${reason} ${WEBGPU_BROWSER_HINT}` : WEBGPU_BROWSER_HINT
  }

  if (droppedHistoryCount.value) {
    return droppedHistoryHint.value
  }

  // The truncation note belongs to the plain path only. Agent mode never sends
  // the graph excerpt at all — it looks the graph up instead — so warning that
  // part of the excerpt was left out would be describing a prompt nobody built.
  if (isAgentMode.value) {
    return agentQualityHint.value
  }

  if (graphContext.value.truncated) {
    return graphTruncationHint.value
  }

  return ''
})

const footerHintIcon = computed(() => {
  return isWebGpuUnavailable.value ? 'i-lucide-triangle-alert' : 'i-lucide-info'
})

const footerHintClass = computed(() => {
  return isWebGpuUnavailable.value ? 'text-error' : 'text-muted'
})

/** What the download popover says above the progress bar. */
const modelDownloadTitle = computed(() => {
  if (isPreparingModel.value) {
    return `Preparing ${describeModelId(preparingModelId.value)}`
  }

  if (loadedModelId.value) {
    return `${describeModelId(loadedModelId.value)} is loaded and cached in this browser`
  }

  return `${downloadTargetLabel.value} downloads once and stays cached in this browser`
})

const modelDownloadElapsedLabel = computed(() => {
  const totalSeconds = Math.max(0, Math.round(modelDownloadElapsedMs.value / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return minutes ? `${minutes}m ${seconds}s elapsed` : `${seconds}s elapsed`
})

/** Weights are cached per browser, so removing them is the only way to get the disk space back. */
const canRemoveSelectedModel = computed(() => {
  const modelId = selectedModel.value

  return Boolean(modelId)
    && !isPreparingModel.value
    && cachedModelIds.value.includes(modelId)
    && loadedModelId.value !== modelId
})

function resolveWebLlmErrorKind(error: unknown): WebLlmErrorKind {
  return error instanceof WebLlmError ? error.kind : 'generate'
}

function describeWebLlmError(kind: WebLlmErrorKind) {
  switch (kind) {
    case 'unsupported':
      return supportReason.value || WEBGPU_BROWSER_HINT
    case 'catalog':
      return 'Couldn\'t list the models this browser can run. Refresh the model list and try again.'
    case 'load':
      return 'The model download didn\'t finish. Check the connection and try again — whatever already downloaded is kept.'
    case 'generate':
      return 'The model stopped before it finished answering. Try again, or pick a smaller model.'
  }
}

/**
 * The message to show for a failed engine call.
 *
 * The composable sets `error` to a user-facing sentence for the failures it owns
 * — the WebGPU probe, the catalog, and loading a model — so that wins there. A
 * generation failure leaves it untouched, and repeating whatever it held last
 * would name the wrong problem.
 */
function readWebLlmDiagnostic(kind: WebLlmErrorKind) {
  if (kind !== 'generate' && engineError.value) {
    return engineError.value
  }

  return describeWebLlmError(kind)
}

function showProviderSelectionToast() {
  toast.add({
    title: 'Select Provider',
    description: 'Choose a provider before sending this message.',
    icon: 'i-lucide-triangle-alert',
    color: 'error'
  })
}

function showWebGpuUnavailableToast(context?: string) {
  toast.add({
    title: 'WebGPU unavailable',
    description: context
      ? `${context} ${WEBGPU_BROWSER_HINT}`
      : WEBGPU_BROWSER_HINT,
    icon: 'i-lucide-triangle-alert',
    color: 'error',
    actions: [{
      label: 'Check browser support',
      color: 'neutral',
      variant: 'outline',
      to: WEBGPU_SUPPORT_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
      external: true
    }]
  })
}

function showModelDownloadErrorToast(description: string) {
  toast.add({
    title: 'Model download problem',
    description,
    icon: 'i-lucide-triangle-alert',
    color: 'error'
  })
}

function showGenerationErrorToast(description: string) {
  toast.add({
    title: 'Generation problem',
    description,
    icon: 'i-lucide-triangle-alert',
    color: 'error'
  })
}

function showModelSelectionToast() {
  toast.add({
    title: 'Select model',
    description: 'Choose a model to run in this browser before sending this message.',
    icon: 'i-lucide-triangle-alert',
    color: 'error'
  })
}

function showModelErrorToast(description: string) {
  toast.add({
    title: 'Model error',
    description,
    icon: 'i-lucide-triangle-alert',
    color: 'error'
  })
}

function showRecommendedModelToast() {
  const vram = recommendedModel.value?.vramMb
    ? ` It needs about ${recommendedModel.value.vramLabel} of GPU memory to run.`
    : ''

  toast.add({
    title: 'No model downloaded yet',
    description: `Download ${downloadTargetLabel.value} to this browser to start chatting.${vram}`,
    icon: 'i-lucide-download',
    color: 'neutral',
    actions: [{
      label: `Download ${downloadTargetLabel.value}`,
      color: 'neutral',
      variant: 'outline',
      onClick: (event?: Event) => {
        event?.stopPropagation()
        handleModelDownloadClick()
      }
    }]
  })
}

async function ensureWebGpuSupport() {
  const supported = await checkSupport()
  hasCheckedSupport.value = true

  if (!supported) {
    modelError.value = supportReason.value || WEBGPU_BROWSER_HINT
    showWebGpuUnavailableToast(supportReason.value)
  }

  return supported
}

async function loadModelCatalog() {
  if (props.preview || !import.meta.client || isLoadingCatalog.value) {
    return
  }

  modelError.value = ''

  if (!await ensureWebGpuSupport()) {
    selectedModel.value = ''
    return
  }

  await refreshCatalog()

  // `refreshCatalog` reports failure through `error` instead of throwing, so a
  // chunk that would not load or a cache that refused the question is only
  // named there. Falling through to the empty-catalog branch would blame the
  // build for a connection problem and give the visitor no reason to retry.
  if (!hasLoadedCatalog.value) {
    const diagnostic = engineError.value || describeWebLlmError('catalog')

    selectedModel.value = ''
    modelError.value = diagnostic
    showModelErrorToast(diagnostic)
    return
  }

  if (!catalog.value.length) {
    selectedModel.value = ''
    modelError.value = 'None of the in-browser models are available in this build.'
    showModelErrorToast(modelError.value)
    return
  }

  const cached = cachedModelIds.value

  if (!cached.length) {
    selectedModel.value = ''
    modelError.value = 'No model has been downloaded to this browser yet.'
    showRecommendedModelToast()
    return
  }

  if (!cached.includes(selectedModel.value)) {
    selectedModel.value = cached[0] || ''
  }
}

/** Fetches the weights, compiles the shaders, and leaves the model on the GPU. */
async function ensureModelReady(modelId: string) {
  if (props.preview || !import.meta.client || isPreparingModel.value) {
    return false
  }

  if (loadedModelId.value === modelId) {
    return true
  }

  isModelDownloadPopoverOpen.value = true

  try {
    await prepareModel(modelId)

    posthog?.capture('Graph AI Model Loaded', {
      url: graphStore.endpointUrl,
      model: modelId
    })

    return true
  } catch (error) {
    const diagnostic = readWebLlmDiagnostic(resolveWebLlmErrorKind(error))

    modelError.value = diagnostic
    showModelDownloadErrorToast(diagnostic)

    return false
  }
}

function handleModelDownloadClick() {
  isModelDownloadPopoverOpen.value = true

  if (isPreparingModel.value) {
    return
  }

  const modelId = downloadTargetModelId.value

  if (selectedModel.value === modelId) {
    void ensureModelReady(modelId)
    return
  }

  selectedModel.value = modelId

  // The `selectedModel` watch only downloads a model that is missing from the
  // cache; this button is an explicit request, so a cached one is warmed here.
  if (cachedModelIds.value.includes(modelId)) {
    void ensureModelReady(modelId)
  }
}

async function handleRemoveSelectedModel() {
  const modelId = selectedModel.value

  if (!modelId) {
    return
  }

  const label = describeModelId(modelId)

  selectedModel.value = ''

  try {
    await deleteModel(modelId)
    await refreshCatalog()
  } catch {
    showModelErrorToast(`Couldn't remove ${label} from this browser.`)
  }
}

function handleRefreshModels() {
  void loadModelCatalog()
}

watch(() => props.active, (value) => {
  if (value && !props.preview) {
    graphStore.fetchMarkdown()

    posthog?.capture('Graph AI Chat Opened', {
      url: graphStore.endpointUrl
    })
  }
}, { immediate: true })

function closePanel() {
  emit('close')
}

/**
 * Cuts a run short.
 *
 * Interrupting the engine only ends the generation that is decoding; an agent
 * loop would carry on to its next turn with an empty answer. The signal is what
 * stops the loop itself.
 */
let agentRun: AbortController | undefined

function abandonAgentRun() {
  agentRun?.abort()
  agentRun = undefined
}

function restartChat() {
  if (!props.preview) {
    abandonAgentRun()
    interrupt()
  }

  prompt.value = ''
  isLoading.value = false
  droppedHistoryCount.value = 0
  messages.value = [createInitialAssistantMessage()]
}

watch(selectedProvider, (provider) => {
  selectedModel.value = ''
  modelError.value = ''
  hasCheckedSupport.value = false

  if (provider === WEB_LLM_PROVIDER) {
    void loadModelCatalog()
  }
})

/**
 * Probes WebGPU and reads the model list as the panel opens, before anything has
 * been typed.
 *
 * A browser that cannot run a model has to say so up front — being told only
 * after asking a question is exactly what the requirements page promises will
 * not happen. It waits for the graph rather than for a provider, because there
 * is only one provider to pick, while a static or too-old graph turns the chat
 * off entirely and warning about a GPU nobody was going to use is noise.
 */
watch(isChatUnavailable, (unavailable) => {
  if (unavailable || props.preview || hasCheckedSupport.value || !selectedProvider.value) {
    return
  }

  void loadModelCatalog()
}, { immediate: true })

watch(selectedModel, (modelId) => {
  if (!modelId) {
    return
  }

  modelError.value = ''

  // Picking a model is what starts its download: in-browser inference has no
  // separate pull step, so fetching the weights and handing them to the GPU is
  // one operation. A model already in the cache is loaded on the first message
  // instead, which keeps switching between downloaded models free.
  if (!cachedModelIds.value.includes(modelId)) {
    void ensureModelReady(modelId)
  }
})

let modelDownloadTimer: ReturnType<typeof setInterval> | undefined

function stopModelDownloadTimer() {
  if (modelDownloadTimer !== undefined) {
    clearInterval(modelDownloadTimer)
    modelDownloadTimer = undefined
  }
}

/**
 * Times the load in the panel.
 *
 * WebLLM reports elapsed time on every progress event, but the composable only
 * forwards the percentage and the label, and a multi-gigabyte download with no
 * clock at all reads as a hang.
 */
watch(isPreparingModel, (preparing) => {
  stopModelDownloadTimer()

  if (!preparing) {
    return
  }

  const startedAt = Date.now()
  modelDownloadElapsedMs.value = 0
  modelDownloadTimer = setInterval(() => {
    modelDownloadElapsedMs.value = Date.now() - startedAt
  }, 1000)
})

// Closing the drawer unmounts the panel, which is when the GPU memory and the
// inference worker have to go back.
onScopeDispose(() => {
  stopModelDownloadTimer()

  if (!props.preview) {
    abandonAgentRun()
    void dispose()
  }
})

/**
 * The conversation as a model should see it.
 *
 * The greeting is dropped: it is the panel introducing itself, not something
 * anyone said, and a model that reads it starts answering as though it had
 * already offered to trace something.
 */
function getConversationTurns(): GraphAgentTurn[] {
  return messages.value
    .filter((message, index) => !(index === 0 && message.role === 'assistant'))
    .filter(message => message.content.trim())
    .map(message => ({
      role: message.role,
      content: message.content
    }))
}

async function handleSubmit(event: Event) {
  event.preventDefault()

  const content = prompt.value.trim()
  if (!content || isLoading.value) {
    return
  }

  if (props.preview) {
    messages.value.push({ role: 'user', content })
    prompt.value = ''
    messages.value.push({
      role: 'assistant',
      content: props.previewReply
    })
    return
  }

  if (!selectedProvider.value) {
    isProviderSelectOpen.value = true
    showProviderSelectionToast()
    return
  }

  if (isWebGpuUnavailable.value) {
    showWebGpuUnavailableToast(supportReason.value)
    return
  }

  if (!selectedModel.value) {
    isModelSelectOpen.value = true

    if (modelError.value && !shouldOfferRecommendedModel.value) {
      showModelErrorToast(modelError.value)
    } else if (shouldOfferRecommendedModel.value) {
      showRecommendedModelToast()
    } else {
      showModelSelectionToast()
    }
    return
  }

  messages.value.push({ role: 'user', content })
  prompt.value = ''

  if (!import.meta.client) {
    return
  }

  isLoading.value = true
  const assistantMessageIndex = messages.value.length

  messages.value.push({
    role: 'assistant',
    content: '',
    reasoning: '',
    reasoningStreaming: true
  })

  const getAssistantMessage = () => messages.value[assistantMessageIndex]
  const updateAssistantMessage = (patch: Partial<ChatMessage>) => {
    const currentMessage = getAssistantMessage()

    if (!currentMessage) {
      return
    }

    messages.value[assistantMessageIndex] = {
      ...currentMessage,
      ...patch
    }
  }

  try {
    const useAgent = isAgentMode.value

    // Only what the chosen mode reads. The plain path answers from the Markdown
    // excerpt; agent mode never sees it, because its tools query the JSON.
    await (useAgent ? graphStore.fetchJson() : graphStore.fetchMarkdown())

    const modelId = selectedModel.value

    // `streamChat` would load the model itself, but going through the panel's
    // own path shows the progress popover for a load that can take minutes and
    // reports a failed download as a download problem rather than as a failed
    // answer.
    if (loadedModelId.value !== modelId && !await ensureModelReady(modelId)) {
      updateAssistantMessage({
        reasoning: '',
        reasoningStreaming: false,
        content: modelError.value || describeWebLlmError('load')
      })
      return
    }

    isModelDownloadPopoverOpen.value = false

    let streamedContent = ''

    // A reasoning model streams its thinking inline, wrapped in `<think>`, so
    // reasoning and answer are both recovered from the same text.
    const renderStreamedReply = (fallbackOnLongThinking: boolean) => {
      const parsedReply = parseStreamingAssistantReply(streamedContent)

      if (parsedReply.reasoning) {
        updateAssistantMessage({
          reasoning: parsedReply.reasoning
        })
      }

      updateAssistantMessage({
        content: parsedReply.content
      })

      if (
        fallbackOnLongThinking
        && !parsedReply.content
        && parsedReply.reasoning.length >= THINKING_FALLBACK_CHAR_LIMIT
      ) {
        throw new ThinkingFallbackError()
      }
    }

    const handleAgentEvent = (event: GraphAgentEvent, fallbackOnLongThinking: boolean) => {
      // The agent reports the whole of the current turn rather than the newest
      // fragment, because a turn that follows a tool result replaces the one
      // before it — appending would render a reply that argues with itself.
      if (event.type === 'answer') {
        streamedContent = event.text
        renderStreamedReply(fallbackOnLongThinking)
        return
      }

      if (event.type === 'stopped') {
        updateAssistantMessage({ notice: event.text })
        return
      }

      const steps = getAssistantMessage()?.toolSteps ?? []

      if (event.type === 'tool-call') {
        updateAssistantMessage({
          toolSteps: [...steps, { id: event.id, name: event.name, args: event.args }]
        })
        return
      }

      updateAssistantMessage({
        toolSteps: steps.map(step => (step.id === event.id ? { ...step, result: event.text } : step))
      })
    }

    // Only the most recent turns that still fit beside the system prompt. The
    // window is 4096 tokens on every curated model and web-llm refuses a prompt
    // over it rather than trimming, so an unbudgeted history means the chat
    // works for a while and then stops working for good.
    //
    // Agent mode reserves more than its system prompt costs, because the loop
    // adds to the same window as it runs: the tool schemas, the assistant turn
    // that made each call, and the lookup that answered it.
    const budgetTurns = () => {
      const history = budgetChatHistory(
        getConversationTurns(),
        useAgent
          ? estimateGraphAgentPromptChars(graphStore.graphData)
          : systemPrompt.value.length
      )

      droppedHistoryCount.value = history.droppedMessageCount

      return history.messages
    }

    const runPlainTurn = async (enableThinking: boolean) => {
      const modelMessages: WebLlmChatMessage[] = [
        {
          role: 'system',
          content: systemPrompt.value
        },
        ...budgetTurns()
      ]

      await streamChat(modelId, modelMessages, { enableThinking, temperature: CHAT_TEMPERATURE }, (delta) => {
        streamedContent += delta.content ?? ''
        renderStreamedReply(enableThinking)
      })
    }

    const runAgentTurn = async (enableThinking: boolean) => {
      // The engine is handed over as the two functions a chat model needs, and
      // nothing more. That is the whole boundary: `ChatWebLlm` sits behind
      // LangChain's `BaseChatModel`, so putting a hosted provider here later is
      // a swap of one object rather than a rewrite of this panel.
      agentRun = new AbortController()

      await runAgent(
        {
          engine: { streamChat, interrupt },
          modelId,
          graph: graphStore.graphData,
          messages: budgetTurns(),
          temperature: CHAT_TEMPERATURE,
          enableThinking,
          signal: agentRun.signal
        },
        (event) => {
          handleAgentEvent(event, enableThinking)
        }
      )
    }

    const runTurn = useAgent ? runAgentTurn : runPlainTurn

    try {
      await runTurn(true)
    } catch (error) {
      if (!(error instanceof ThinkingFallbackError)) {
        throw error
      }

      // The abandoned run has to be told it is abandoned before a second one
      // starts. `runGraphAgent` cancels its own stream on the way out, and this
      // is the belt to that pair of braces: two loops decoding for one question
      // would queue behind each other on web-llm's per-model lock.
      abandonAgentRun()

      // The retry is a fresh attempt at the same question, so the lookups the
      // abandoned one made are not part of the answer that survives.
      updateAssistantMessage({
        reasoningStreaming: false,
        toolSteps: [],
        notice: ''
      })

      streamedContent = ''

      await runTurn(false)
    }

    const parsedReply = parseAssistantReply(streamedContent)

    const finalMessage = getAssistantMessage()
    const finalContent = finalMessage?.content
      || parsedReply.content
      // A loop that gave up already said so in its own words, and adding a
      // second sentence about producing no response would contradict it.
      || (finalMessage?.notice ? '' : 'I could not produce a response with this model.')

    if (!finalMessage?.reasoning && parsedReply.reasoning) {
      updateAssistantMessage({
        reasoning: parsedReply.reasoning
      })
    }

    updateAssistantMessage({
      reasoningStreaming: false,
      content: finalContent
    })

    posthog?.capture('Graph AI Answer Completed', {
      url: graphStore.endpointUrl,
      model: modelId,
      mode: useAgent ? 'agent' : 'chat',
      toolCalls: getAssistantMessage()?.toolSteps?.length || 0
    })
  } catch (error) {
    // A restart or a closed drawer aborted the run. The transcript it was
    // writing into is already gone, so there is nothing to report and nobody to
    // report it to.
    if (error instanceof Error && error.name === 'AbortError') {
      return
    }

    const kind = resolveWebLlmErrorKind(error)
    // The window overflow has to be named for what it is. It reads as a
    // generation failure, and the generic advice for one — try again, pick a
    // smaller model — cannot work here: a retry sends the same conversation,
    // and every model on offer has the same 4096-token window.
    const diagnostic = isContextWindowOverflow(error)
      ? CONTEXT_WINDOW_OVERFLOW_MESSAGE
      : readWebLlmDiagnostic(kind)

    if (kind === 'unsupported') {
      hasCheckedSupport.value = true
      modelError.value = diagnostic
      showWebGpuUnavailableToast(supportReason.value)
    } else if (kind === 'load') {
      modelError.value = diagnostic
      showModelDownloadErrorToast(diagnostic)
    } else {
      showGenerationErrorToast(diagnostic)
    }

    updateAssistantMessage({
      reasoning: '',
      reasoningStreaming: false,
      content: diagnostic
    })
  } finally {
    agentRun = undefined
    isLoading.value = false
  }
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden bg-default">
    <div
      v-if="props.showHeader"
      class="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-default px-4"
    >
      <div class="flex min-w-0 items-center gap-2">
        <UIcon
          name="i-lucide-sparkles"
          class="size-4 shrink-0 text-primary"
        />
        <p class="truncate text-sm font-medium">
          {{ props.title }}
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <UButton
          type="button"
          icon="i-lucide-rotate-ccw"
          color="neutral"
          variant="ghost"
          size="sm"
          :disabled="isChatControlDisabled"
          aria-label="Restart chat"
          @click="restartChat"
        />
        <UButton
          v-if="props.showClose"
          type="button"
          icon="i-lucide-x"
          color="neutral"
          variant="ghost"
          size="sm"
          aria-label="Close AI chat"
          @click="closePanel"
        />
      </div>
    </div>

    <UChatPalette
      class="min-h-0 flex-1 overflow-hidden"
      :ui="{
        content: props.contentClass,
        prompt: props.promptClass
      }"
    >
      <UChatMessages
        :messages="chatMessages"
        :status="isStreaming ? 'streaming' : 'ready'"
        :assistant="{ side: 'left', variant: 'naked' }"
        :user="{ side: 'right', variant: 'soft' }"
        compact
        should-auto-scroll
      >
        <template #content="{ message }">
          <UChatReasoning
            v-if="message.metadata?.reasoning || message.metadata?.reasoningStreaming"
            :text="message.metadata?.reasoning || ''"
            :streaming="message.metadata?.reasoningStreaming"
            :default-open="message.metadata?.reasoningStreaming"
            icon="i-lucide-brain"
            chevron="leading"
            :auto-close-delay="1000"
          />

          <!--
            The lookups behind the answer, shown as they happen. A ReAct loop is
            otherwise a long silence with a paragraph at the end, and a reader
            who cannot see which tool ran has no way to tell a slow answer from
            a model going round in circles.
          -->
          <div
            v-if="message.metadata?.toolSteps?.length"
            class="my-1 space-y-1"
          >
            <details
              v-for="step in message.metadata.toolSteps"
              :key="step.id"
              class="rounded-md border border-default bg-elevated/50 px-2 py-1.5 text-xs"
            >
              <summary class="flex cursor-pointer items-center gap-1.5 text-muted marker:content-['']">
                <UIcon
                  :name="step.result ? 'i-lucide-check' : 'i-lucide-loader-circle'"
                  class="size-3.5 shrink-0"
                  :class="step.result ? 'text-success' : 'animate-spin'"
                />
                <span class="font-mono">{{ step.name }}</span>
                <span
                  v-if="step.args"
                  class="truncate font-mono opacity-70"
                >{{ step.args }}</span>
              </summary>
              <pre
                v-if="step.result"
                class="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-muted"
              >{{ step.result }}</pre>
            </details>
          </div>

          <MDC
            v-if="message.content"
            :value="message.content"
            tag="div"
          />

          <p
            v-if="message.metadata?.notice"
            class="mt-1 flex items-start gap-1.5 text-xs text-muted"
          >
            <UIcon
              name="i-lucide-circle-slash"
              class="mt-0.5 size-3.5 shrink-0"
            />
            <span>{{ message.metadata.notice }}</span>
          </p>
        </template>
      </UChatMessages>

      <template #prompt>
        <UChatPrompt
          v-model="prompt"
          icon="i-lucide-sparkles"
          :placeholder="promptPlaceholder"
          variant="subtle"
          :autofocus="!props.preview && props.active"
          :rows="1"
          :maxrows="4"
          :disabled="isPromptDisabled"
          @submit="handleSubmit"
        >
          <UChatPromptSubmit
            color="neutral"
            :status="isStreaming ? 'submitted' : 'ready'"
            :disabled="isChatSubmitDisabled"
          />

          <template #footer>
            <div class="min-w-0 space-y-2">
              <p
                v-if="footerHint"
                class="flex items-start gap-1.5 text-xs"
                :class="footerHintClass"
              >
                <UIcon
                  :name="footerHintIcon"
                  class="mt-0.5 size-3.5 shrink-0"
                />
                <span>{{ footerHint }}</span>
              </p>

              <UFieldGroup v-if="props.preview">
                <USelect
                  v-model="previewProvider"
                  :items="providerItems"
                  icon="i-lucide-cpu"
                  class="min-w-0 flex-1"
                  placeholder="Select provider"
                  variant="ghost"
                  :ui="{ content: 'min-w-fit' }"
                >
                  <template #content-top>
                    <p class="px-2 py-1.5 text-xs font-medium text-muted">
                      Mock Provider
                    </p>
                  </template>
                </USelect>
                <USelect
                  v-model="previewModel"
                  :items="previewModelItems"
                  icon="i-lucide-brain"
                  class="min-w-0 flex-1"
                  placeholder="Select model"
                  variant="ghost"
                  :ui="{ content: 'min-w-fit' }"
                />
                <UButton
                  type="button"
                  icon="i-lucide-refresh-cw"
                  color="neutral"
                  variant="ghost"
                  disabled
                  aria-label="Refresh preview models"
                />
              </UFieldGroup>
              <UFieldGroup v-else>
                <USelect
                  v-model="selectedProvider"
                  v-model:open="isProviderSelectOpen"
                  :items="providerItems"
                  :icon="selectedProviderIcon"
                  :disabled="isChatControlDisabled"
                  class="min-w-0 flex-1"
                  placeholder="Select provider"
                  variant="ghost"
                  :ui="{ content: 'min-w-fit' }"
                >
                  <template #content-top>
                    <p class="px-2 py-1.5 text-xs font-medium text-muted">
                      {{ selectedProvider ? 'Change Provider' : 'Select Provider' }}
                    </p>
                  </template>
                </USelect>
                <USelect
                  v-model="selectedModel"
                  v-model:open="isModelSelectOpen"
                  :items="modelItems"
                  :loading="isCheckingSupport || isLoadingCatalog || isPreparingModel"
                  :disabled="isChatControlDisabled || !selectedProvider || isWebGpuUnavailable"
                  icon="i-lucide-brain"
                  class="min-w-0 flex-1"
                  placeholder="Select model"
                  variant="ghost"
                  :ui="{ content: 'min-w-fit' }"
                />
                <!--
                  Agent mode runs on every model in the list, the recommended
                  2 GB one included, so this is a choice about the question and
                  never about the hardware: looking things up beats reading a
                  truncated excerpt on a large graph, and costs several turns
                  for a question a small graph answers in one.
                -->
                <UTooltip :text="isAgentMode ? 'Answering by looking things up in the graph. Click to answer from a graph excerpt instead.' : 'Answering from a graph excerpt. Click to let the model look things up with tools.'">
                  <UButton
                    type="button"
                    icon="i-lucide-wrench"
                    :color="isAgentMode ? 'primary' : 'neutral'"
                    :variant="isAgentMode ? 'soft' : 'ghost'"
                    :disabled="isChatControlDisabled || isStreaming"
                    :aria-pressed="isAgentMode"
                    aria-label="Look things up with tools"
                    @click="isAgentMode = !isAgentMode"
                  />
                </UTooltip>
                <UPopover
                  v-model:open="isModelDownloadPopoverOpen"
                  :content="{ side: 'top', align: 'end', sideOffset: 8 }"
                  arrow
                >
                  <UButton
                    type="button"
                    icon="i-lucide-download"
                    color="neutral"
                    variant="ghost"
                    :disabled="isChatControlDisabled"
                    :aria-label="`Download ${downloadTargetLabel}`"
                    @click="handleModelDownloadClick"
                  />

                  <template #content>
                    <div class="w-72 space-y-3 p-3 text-sm">
                      <div class="space-y-1">
                        <p class="font-medium text-highlighted">
                          Download model
                        </p>
                        <p class="text-muted">
                          {{ modelDownloadTitle }}
                        </p>
                      </div>

                      <div class="space-y-1.5">
                        <div class="h-2 overflow-hidden rounded-full bg-muted">
                          <div
                            class="h-full rounded-full bg-primary transition-all"
                            :style="{ width: `${progressPercent}%` }"
                          />
                        </div>
                        <div class="flex items-center justify-between gap-2 text-xs text-muted">
                          <span>{{ progressPercent }}%</span>
                          <span>{{ modelDownloadElapsedLabel }}</span>
                        </div>
                      </div>

                      <p class="truncate text-xs text-muted">
                        {{ progressLabel || 'Ready to download' }}
                      </p>

                      <div
                        v-if="progressEvents.length"
                        class="space-y-1 border-t border-default pt-2"
                      >
                        <p
                          v-for="(event, index) in progressEvents"
                          :key="`${index}-${event}`"
                          class="truncate text-xs text-muted"
                        >
                          {{ event }}
                        </p>
                      </div>

                      <div
                        v-if="canRemoveSelectedModel"
                        class="border-t border-default pt-2"
                      >
                        <UButton
                          type="button"
                          icon="i-lucide-trash-2"
                          color="neutral"
                          variant="ghost"
                          size="xs"
                          :label="`Remove ${downloadTargetLabel} from this browser`"
                          @click="handleRemoveSelectedModel"
                        />
                      </div>
                    </div>
                  </template>
                </UPopover>
                <UButton
                  type="button"
                  icon="i-lucide-refresh-cw"
                  color="neutral"
                  variant="ghost"
                  :loading="isCheckingSupport || isLoadingCatalog"
                  :disabled="isChatControlDisabled || isStreaming || isPreparingModel || !selectedProvider"
                  aria-label="Refresh WebLLM models"
                  @click="handleRefreshModels"
                />
              </UFieldGroup>
            </div>
          </template>
        </UChatPrompt>
      </template>
    </UChatPalette>
  </div>
</template>
