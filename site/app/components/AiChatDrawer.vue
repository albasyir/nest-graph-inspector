<script setup lang="ts">
type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  reasoningStreaming?: boolean
}

type OllamaModel = {
  name: string
}

type OllamaTagsResponse = {
  models?: OllamaModel[]
}

type OllamaShowResponse = {
  capabilities?: string[]
}

type OllamaChatMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

type OllamaChatStreamResponse = {
  message?: {
    content?: string
    thinking?: string
  }
  error?: string
  done?: boolean
}

type OllamaPullStreamResponse = {
  status?: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

type ModelSelectItem = {
  label: string
  value?: string
  type?: 'label' | 'separator'
  icon?: string
  description?: string
  disabled?: boolean
  onSelect?: () => void
}

const OLLAMA_PROXY_PATH = '/ollama'
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'
const OLLAMA_THINKING_EFFORT = 'low'
const OLLAMA_THINKING_FALLBACK_CHAR_LIMIT = 3000
const DEFAULT_DOWNLOAD_MODEL = 'qwen3:4b'
const DOWNLOADABLE_MODEL_VALUES = ['qwen3.5:4b', 'qwen3:4b', 'qwen3:8b']

class OllamaThinkingFallbackError extends Error {
  constructor() {
    super('Ollama thinking stream did not produce answer content quickly enough.')
  }
}

const open = defineModel<boolean>('open', { default: false })
const prompt = ref('')
const isLoading = ref(false)
const isLoadingModels = ref(false)
const hasLoadedModels = ref(false)
const isDownloadingRecommendedModel = ref(false)
const modelError = ref('')
const isOllamaUnavailable = ref(false)
const isProviderSelectOpen = ref(false)
const isModelSelectOpen = ref(false)
const isRecommendedModelDownloadPopoverOpen = ref(false)
const recommendedModelDownloadStatus = ref('')
const recommendedModelDownloadDigest = ref('')
const recommendedModelDownloadTotal = ref(0)
const recommendedModelDownloadCompleted = ref(0)
const recommendedModelDownloadEvents = ref<string[]>([])
const selectedDownloadModel = ref(DEFAULT_DOWNLOAD_MODEL)
const selectedProvider = ref('')
const selectedModel = ref('')
const downloadedModels = ref<string[]>([])
const initialAssistantMessage: ChatMessage = {
  role: 'assistant',
  content: 'Hi, I can help you inspect this NestJS graph. Ask me to trace a dependency, explain a module, or find where a provider is used.'
}
const messages = ref<ChatMessage[]>([{ ...initialAssistantMessage }])

const posthog = usePostHog()
const graphStore = useGraphInspectorStore()
const toast = useToast()

const providerItems = [
  {
    label: 'Ollama',
    value: 'ollama',
    icon: 'i-simple-icons-ollama'
  }
]

const downloadModelItems = DOWNLOADABLE_MODEL_VALUES.map(model => ({
  label: model,
  value: model,
  icon: 'i-lucide-brain'
}))

const modelItems = computed<ModelSelectItem[]>(() => {
  const downloadedModelItems: ModelSelectItem[] = downloadedModels.value.map(model => ({
    label: model,
    value: model,
    icon: 'i-lucide-brain',
    description: 'Downloaded'
  }))
  const downloadableModelItems: ModelSelectItem[] = DOWNLOADABLE_MODEL_VALUES
    .filter(model => !downloadedModels.value.includes(model))
    .map(model => ({
      label: model,
      value: `download:${model}`,
      icon: 'i-lucide-download',
      description: 'Download',
      disabled: isDownloadingRecommendedModel.value,
      onSelect: () => {
        downloadModel(model)
      }
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

const isAIAvailable = computed(() => {
  // TODO: this temporary solution
  return graphStore.decodedUrl.includes('mock-graph') || graphStore.graphData?.version == '1' || graphStore.graphData?.version == '0'
})

const chatMessages = computed(() => messages.value.map((message, index) => ({
  id: `message-${index}`,
  role: message.role,
  content: message.content,
  parts: message.content
    ? [{
        type: 'text' as const,
        text: message.content
      }]
    : [],
  metadata: {
    reasoning: message.reasoning,
    reasoningStreaming: message.reasoningStreaming
  }
})))

const shouldShowRecommendedModelDownload = computed(() => {
  return selectedProvider.value === 'ollama'
    && hasLoadedModels.value
    && !isLoadingModels.value
    && !isOllamaUnavailable.value
    && !downloadedModels.value.length
})

const shouldShowRecommendedModelDownloadControl = computed(() => {
  return shouldShowRecommendedModelDownload.value
    || isDownloadingRecommendedModel.value
    || Boolean(recommendedModelDownloadStatus.value)
})

const recommendedModelDownloadProgress = computed(() => {
  if (!recommendedModelDownloadTotal.value) {
    return 0
  }

  return Math.min(
    100,
    Math.round((recommendedModelDownloadCompleted.value / recommendedModelDownloadTotal.value) * 100)
  )
})

const recommendedModelDownloadCompletedLabel = computed(() => {
  return formatBytes(recommendedModelDownloadCompleted.value)
})

const recommendedModelDownloadTotalLabel = computed(() => {
  return formatBytes(recommendedModelDownloadTotal.value)
})

function formatBytes(value: number) {
  if (!value) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB']
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const amount = value / 1024 ** exponent

  return `${amount.toFixed(amount >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`
}

function showProviderSelectionToast() {
  toast.add({
    title: 'Select Provider',
    description: 'Choose a provider before sending this message.',
    icon: 'i-lucide-triangle-alert',
    color: 'error'
  })
}

function showOllamaUnavailableToast() {
  toast.add({
    title: 'Ollama unavailable',
    description: 'Please install Ollama and start it before selecting a model.',
    icon: 'i-lucide-triangle-alert',
    color: 'error',
    actions: [{
      label: 'Install Ollama',
      color: 'neutral',
      variant: 'outline',
      to: OLLAMA_DOWNLOAD_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
      external: true
    }]
  })
}

function showModelSelectionToast() {
  toast.add({
    title: 'Select model',
    description: 'Choose a downloaded Ollama model before sending this message.',
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
  toast.add({
    title: 'No completion model found',
    description: `Download ${selectedDownloadModel.value} to start chatting.`,
    icon: 'i-lucide-download',
    color: 'neutral',
    actions: [{
      label: `Download ${selectedDownloadModel.value}`,
      color: 'neutral',
      variant: 'outline',
      onClick: (event?: Event) => {
        event?.stopPropagation()
        isRecommendedModelDownloadPopoverOpen.value = true
        downloadModel(selectedDownloadModel.value)
      }
    }]
  })
}

function handleRecommendedModelDownloadClick() {
  isRecommendedModelDownloadPopoverOpen.value = true

  if (!isDownloadingRecommendedModel.value) {
    downloadModel(selectedDownloadModel.value)
  }
}

function hasCompletionCapability(capabilities?: string[]) {
  const normalizedCapabilities = capabilities?.map(capability => capability.toLowerCase()) || []

  return normalizedCapabilities.includes('completion')
}

function getOllamaApiUrl(path: string) {
  if (!graphStore.ollamaUrl) {
    throw new Error('Ollama proxy URL is unavailable because the graph endpoint is not loaded.')
  }

  const normalizedPath = path.startsWith('/') ? path : `/${path}`

  return `${graphStore.ollamaUrl}${normalizedPath}`
}

async function loadModelCapabilities(model: string) {
  const response = await fetch(getOllamaApiUrl('/api/show'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model })
  })

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status} for ${model}`)
  }

  return await response.json() as OllamaShowResponse
}

async function loadDownloadedModels(options: { fallbackProvider?: string } = {}) {
  if (!import.meta.client || isLoadingModels.value || selectedProvider.value !== 'ollama') {
    return
  }

  isLoadingModels.value = true
  hasLoadedModels.value = false
  modelError.value = ''
  isOllamaUnavailable.value = false

  try {
    const response = await fetch(getOllamaApiUrl('/api/tags'))
    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`)
    }

    const data = await response.json() as OllamaTagsResponse
    const models = data.models?.map(model => model.name).filter(Boolean) || []
    const modelsWithCapabilities = await Promise.all(models.map(async (model) => {
      try {
        const details = await loadModelCapabilities(model)

        return {
          model,
          capabilities: details.capabilities
        }
      } catch {
        return {
          model,
          capabilities: []
        }
      }
    }))
    const completionModels = modelsWithCapabilities
      .filter(({ capabilities }) => hasCompletionCapability(capabilities))
      .map(({ model }) => model)

    downloadedModels.value = completionModels
    hasLoadedModels.value = true

    if (!completionModels.length) {
      selectedModel.value = ''
      modelError.value = 'No downloaded Ollama models with the completion capability found.'
      showRecommendedModelToast()
      return
    }

    if (!completionModels.includes(selectedModel.value)) {
      selectedModel.value = completionModels[0] || ''
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load Ollama models.'

    selectedModel.value = ''
    downloadedModels.value = []
    hasLoadedModels.value = false

    if (options.fallbackProvider !== undefined && selectedProvider.value === 'ollama') {
      selectedProvider.value = options.fallbackProvider
      await nextTick()
    }

    isOllamaUnavailable.value = true
    modelError.value = message
    showOllamaUnavailableToast()
  } finally {
    isLoadingModels.value = false
  }
}

watch(open, (value) => {
  if (value) {
    graphStore.fetchMarkdown()

    posthog?.capture('Graph AI Chat Opened', {
      url: graphStore.decodedUrl
    })
  }
})

function closePanel() {
  open.value = false
}

function restartChat() {
  prompt.value = ''
  isLoading.value = false
  messages.value = [{ ...initialAssistantMessage }]
}

watch(selectedProvider, (provider, previousProvider) => {
  selectedModel.value = ''
  downloadedModels.value = []
  hasLoadedModels.value = false
  modelError.value = ''
  isOllamaUnavailable.value = false

  if (provider === 'ollama') {
    loadDownloadedModels({ fallbackProvider: previousProvider })
  }
})

watch(selectedModel, (model) => {
  if (model?.startsWith('download:')) {
    selectedModel.value = ''
    downloadModel(model.slice('download:'.length))
    return
  }

  if (model) {
    modelError.value = ''
  }
})

function resetRecommendedModelDownloadProgress() {
  recommendedModelDownloadStatus.value = 'Preparing download'
  recommendedModelDownloadDigest.value = ''
  recommendedModelDownloadTotal.value = 0
  recommendedModelDownloadCompleted.value = 0
  recommendedModelDownloadEvents.value = []
}

function parseOllamaPullLine(line: string) {
  try {
    return JSON.parse(line) as OllamaPullStreamResponse
  } catch {
    return null
  }
}

function updateRecommendedModelDownloadProgress(chunk: OllamaPullStreamResponse) {
  if (chunk.error) {
    throw new Error(chunk.error)
  }

  if (chunk.status) {
    recommendedModelDownloadStatus.value = chunk.status

    const event = chunk.digest
      ? `${chunk.status} ${chunk.digest.slice(0, 18)}`
      : chunk.status

    if (recommendedModelDownloadEvents.value.at(-1) !== event) {
      recommendedModelDownloadEvents.value = [
        ...recommendedModelDownloadEvents.value.slice(-5),
        event
      ]
    }
  }

  if (chunk.digest) {
    recommendedModelDownloadDigest.value = chunk.digest
  }

  if (typeof chunk.total === 'number') {
    recommendedModelDownloadTotal.value = chunk.total
  }

  if (typeof chunk.completed === 'number') {
    recommendedModelDownloadCompleted.value = chunk.completed
  }
}

async function streamRecommendedModelDownload(response: Response) {
  if (!response.body) {
    throw new Error('Ollama did not return a readable download stream.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''

  try {
    while (true) {
      const { value, done } = await reader.read()

      if (done) {
        break
      }

      pending += decoder.decode(value, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() || ''

      for (const line of lines) {
        const chunk = parseOllamaPullLine(line.trim())
        if (chunk) {
          updateRecommendedModelDownloadProgress(chunk)
        }
      }
    }

    pending += decoder.decode()

    const chunk = parseOllamaPullLine(pending.trim())
    if (chunk) {
      updateRecommendedModelDownloadProgress(chunk)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

async function downloadModel(model: string) {
  if (!import.meta.client || isDownloadingRecommendedModel.value || selectedProvider.value !== 'ollama') {
    return
  }

  selectedDownloadModel.value = model
  isDownloadingRecommendedModel.value = true
  isRecommendedModelDownloadPopoverOpen.value = true
  resetRecommendedModelDownloadProgress()
  modelError.value = ''
  isOllamaUnavailable.value = false

  try {
    const response = await fetch(getOllamaApiUrl('/api/pull'), {
      method: 'POST',
      body: JSON.stringify({
        model,
        stream: true
      })
    })

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status} while downloading ${model}`)
    }

    await streamRecommendedModelDownload(response)
    recommendedModelDownloadStatus.value = 'success'
    await loadDownloadedModels()
  } catch (error) {
    const message = error instanceof Error ? error.message : `Unable to download ${model}.`

    modelError.value = message
    recommendedModelDownloadStatus.value = 'Download failed'
    showModelErrorToast(message)
  } finally {
    isDownloadingRecommendedModel.value = false
  }
}

const systemPrompt = computed(() => {
  return [
    '# Nest Graph Inspector AI Assistant',
    '',
    '## Instructions',
    '',
    '- Use only the dependency graph markdown below as your source of truth.',
    '- Help users understand NestJS modules, imports, exports, controllers, providers, and dependency paths.',
    '- When the graph does not contain enough information, say what is missing instead of guessing.',
    '- Keep answers concise and mention exact module/provider/controller names from the graph.',
    '- Format user-facing answers with GitHub-flavored Markdown.',
    '- Do not return JSON.',
    '- Keep any model thinking brief, then provide the final answer.',
    '',
    '## Dependency Graph Markdown',
    '',
    graphStore.graphMarkdown || '_No graph markdown is available yet._'
  ].join('\n')
})

function getContentText(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') {
        return part
      }

      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        return part.text
      }

      return ''
    }).join('')
  }

  return ''
}

function getTaggedContent(content: string, tag: string) {
  const match = content.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*</${tag}>`, 'i'))

  return match?.[1]?.trim() || ''
}

function parseAssistantReply(content: string) {
  const reasoning = getTaggedContent(content, 'reasoning') || getTaggedContent(content, 'think')
  const answer = getTaggedContent(content, 'answer')

  if (answer) {
    return {
      reasoning,
      content: answer
    }
  }

  return {
    reasoning,
    content: content
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/i, '')
      .replace(/<think>[\s\S]*?<\/think>/i, '')
      .trim()
  }
}

function parseStreamingAssistantReply(content: string) {
  const lowerContent = content.toLowerCase()
  const reasoningOpenTag = '<reasoning>'
  const reasoningCloseTag = '</reasoning>'
  const thinkOpenTag = '<think>'
  const thinkCloseTag = '</think>'
  const answerOpenTag = '<answer>'
  const answerCloseTag = '</answer>'
  const reasoningOpenIndex = lowerContent.indexOf(reasoningOpenTag)
  const reasoningCloseIndex = lowerContent.indexOf(reasoningCloseTag)
  const thinkOpenIndex = lowerContent.indexOf(thinkOpenTag)
  const thinkCloseIndex = lowerContent.indexOf(thinkCloseTag)
  const answerOpenIndex = lowerContent.indexOf(answerOpenTag)
  const answerCloseIndex = lowerContent.indexOf(answerCloseTag)
  const activeReasoningOpenTag = reasoningOpenIndex === -1 ? thinkOpenTag : reasoningOpenTag
  const activeReasoningCloseTag = reasoningOpenIndex === -1 ? thinkCloseTag : reasoningCloseTag
  const activeReasoningOpenIndex = reasoningOpenIndex === -1 ? thinkOpenIndex : reasoningOpenIndex
  const activeReasoningCloseIndex = reasoningOpenIndex === -1 ? thinkCloseIndex : reasoningCloseIndex

  const reasoning = activeReasoningOpenIndex === -1
    ? ''
    : content
        .slice(
          activeReasoningOpenIndex + activeReasoningOpenTag.length,
          activeReasoningCloseIndex === -1 ? content.length : activeReasoningCloseIndex
        )
        .trim()

  if (answerOpenIndex !== -1) {
    return {
      reasoning,
      content: content
        .slice(
          answerOpenIndex + answerOpenTag.length,
          answerCloseIndex === -1 ? content.length : answerCloseIndex
        )
        .trim()
    }
  }

  if (activeReasoningCloseIndex !== -1) {
    return {
      reasoning,
      content: content
        .slice(activeReasoningCloseIndex + activeReasoningCloseTag.length)
        .replace(new RegExp(answerOpenTag, 'gi'), '')
        .replace(new RegExp(answerCloseTag, 'gi'), '')
        .trim()
    }
  }

  return {
    reasoning,
    content: activeReasoningOpenIndex === -1
      ? content
          .replace(new RegExp(answerOpenTag, 'gi'), '')
          .replace(new RegExp(answerCloseTag, 'gi'), '')
          .trim()
      : ''
  }
}

function getStreamReasoningText(chunk: unknown) {
  const additionalKwargs = (chunk as { additional_kwargs?: Record<string, unknown> }).additional_kwargs
  const reasoningContent = additionalKwargs?.reasoning_content

  return typeof reasoningContent === 'string' ? reasoningContent : ''
}

function getAgentMessages(): OllamaChatMessage[] {
  return messages.value
    .filter((message, index) => !(index === 0 && message.role === 'assistant'))
    .filter(message => message.content.trim())
    .map(message => ({
      role: message.role,
      content: message.content
    }))
}

function parseOllamaStreamLine(line: string) {
  try {
    return JSON.parse(line) as OllamaChatStreamResponse
  } catch {
    return null
  }
}

async function streamOllamaChat(
  model: string,
  modelMessages: OllamaChatMessage[],
  think: boolean | 'low' | 'medium' | 'high',
  onChunk: (chunk: OllamaChatStreamResponse) => void
) {
  const response = await fetch(getOllamaApiUrl('/api/chat'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: modelMessages,
      stream: true,
      think,
      options: {
        temperature: 0.2
      }
    })
  })

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status} while streaming chat.`)
  }

  if (!response.body) {
    throw new Error('Ollama did not return a readable stream.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''

  try {
    while (true) {
      const { value, done } = await reader.read()

      if (done) {
        break
      }

      pending += decoder.decode(value, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() || ''

      for (const line of lines) {
        const trimmedLine = line.trim()
        if (!trimmedLine) {
          continue
        }

        const chunk = parseOllamaStreamLine(trimmedLine)
        if (!chunk) {
          continue
        }

        if (chunk.error) {
          throw new Error(chunk.error)
        }

        onChunk(chunk)

        if (chunk.done) {
          return
        }
      }
    }

    pending += decoder.decode()

    const finalLine = pending.trim()
    if (finalLine) {
      const chunk = parseOllamaStreamLine(finalLine)

      if (chunk?.error) {
        throw new Error(chunk.error)
      }

      if (chunk) {
        onChunk(chunk)
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

async function handleSubmit(event: Event) {
  event.preventDefault()

  const content = prompt.value.trim()
  if (!content || isLoading.value) {
    return
  }

  if (!selectedProvider.value) {
    isProviderSelectOpen.value = true
    showProviderSelectionToast()
    return
  }

  if (isOllamaUnavailable.value) {
    showOllamaUnavailableToast()
    return
  }

  if (!selectedModel.value) {
    isModelSelectOpen.value = true
    if (modelError.value && !shouldShowRecommendedModelDownload.value) {
      showModelErrorToast(modelError.value)
    } else if (shouldShowRecommendedModelDownload.value) {
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
    await graphStore.fetchMarkdown()

    const modelMessages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: systemPrompt.value
      },
      ...getAgentMessages()
    ]

    let streamedContent = ''
    const handleOllamaChunk = (chunk: OllamaChatStreamResponse, fallbackOnLongThinking: boolean) => {
      const reasoningDelta = chunk.message?.thinking || getStreamReasoningText(chunk)
      const contentDelta = getContentText(chunk.message?.content)

      if (reasoningDelta) {
        const currentReasoning = getAssistantMessage()?.reasoning || ''
        const nextReasoning = `${currentReasoning}${reasoningDelta}`

        updateAssistantMessage({
          reasoning: nextReasoning
        })

        if (
          fallbackOnLongThinking
          && !streamedContent
          && nextReasoning.length >= OLLAMA_THINKING_FALLBACK_CHAR_LIMIT
        ) {
          throw new OllamaThinkingFallbackError()
        }
      }

      if (contentDelta) {
        streamedContent += contentDelta

        const parsedReply = parseStreamingAssistantReply(streamedContent)
        if (parsedReply.reasoning && !reasoningDelta) {
          updateAssistantMessage({
            reasoning: parsedReply.reasoning
          })
        }

        updateAssistantMessage({
          content: parsedReply.content
        })
      }
    }

    try {
      await streamOllamaChat(selectedModel.value, modelMessages, OLLAMA_THINKING_EFFORT, (chunk) => {
        handleOllamaChunk(chunk, true)
      })
    } catch (error) {
      if (!(error instanceof OllamaThinkingFallbackError)) {
        throw error
      }

      updateAssistantMessage({
        reasoningStreaming: false
      })

      streamedContent = ''

      await streamOllamaChat(selectedModel.value, modelMessages, false, (chunk) => {
        handleOllamaChunk(chunk, false)
      })
    }

    const parsedReply = parseAssistantReply(streamedContent)

    const finalMessage = getAssistantMessage()
    const finalContent = finalMessage?.content || parsedReply.content || 'I could not produce a response from Ollama.'

    if (!finalMessage?.reasoning && parsedReply.reasoning) {
      updateAssistantMessage({
        reasoning: parsedReply.reasoning
      })
    }

    updateAssistantMessage({
      reasoningStreaming: false,
      content: finalContent
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'

    updateAssistantMessage({
      reasoning: '',
      reasoningStreaming: false,
      content: `I could not reach Ollama through the graph proxy at ${graphStore.ollamaUrl || OLLAMA_PROXY_PATH}. Make sure Ollama is running, the selected model is available, and the graph inspector proxy is configured. Error: ${message}`
    })
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <UDashboardPanel
    v-if="open"
    id="graph-ai-chat"
    resizable
    :default-size="32"
    :min-size="24"
    :max-size="48"
    class="order-3 fixed inset-0 z-50 min-h-0 bg-default lg:relative lg:inset-auto lg:z-auto lg:border-s lg:border-default lg:not-last:border-e-0"
  >
    <div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-default px-4">
      <div class="flex min-w-0 items-center gap-2">
        <UIcon
          name="i-lucide-sparkles"
          class="size-4 shrink-0 text-primary"
        />
        <p class="truncate text-sm font-medium">
          Ask AI
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <UButton
          type="button"
          icon="i-lucide-rotate-ccw"
          color="neutral"
          variant="ghost"
          size="sm"
          :disabled="isLoading"
          aria-label="Restart chat"
          @click="restartChat"
        />
        <UButton
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
      class="min-h-0 flex-1"
      :ui="{
        content: 'px-4 sm:px-5 py-4',
        prompt: 'px-4 sm:px-5 py-4 bg-default'
      }"
    >
      <UChatMessages
        :messages="chatMessages"
        status="ready"
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
            icon="i-lucide-brain"
            chevron="leading"
            :auto-close-delay="1000"
          />

          <MDC
            v-if="message.content"
            :value="message.content"
            tag="div"
          />
        </template>
      </UChatMessages>

      <template #prompt>
        <UChatPrompt
          v-model="prompt"
          icon="i-lucide-sparkles"
          :placeholder="isAIAvailable ? 'DISABLED: Dont use Example or Update Package' : 'Ask about this graph...'"
          variant="subtle"
          :rows="1"
          :maxrows="4"
          :disabled="isAIAvailable || isLoading || isDownloadingRecommendedModel"
          @submit="handleSubmit"
        >
          <UChatPromptSubmit
            color="neutral"
            :status="isLoading ? 'submitted' : 'ready'"
          />

          <template #footer>
            <UFieldGroup>
              <USelect
                v-model="selectedProvider"
                v-model:open="isProviderSelectOpen"
                :items="providerItems"
                :icon="selectedProviderIcon"
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
                :loading="isLoadingModels || isDownloadingRecommendedModel"
                :disabled="!selectedProvider"
                icon="i-lucide-brain"
                class="min-w-0 flex-1"
                placeholder="Select model"
                variant="ghost"
                :ui="{ content: 'min-w-fit' }"
              />
              <UPopover
                v-model:open="isRecommendedModelDownloadPopoverOpen"
                :content="{ side: 'top', align: 'end', sideOffset: 8 }"
                arrow
              >
                <UButton
                  type="button"
                  icon="i-lucide-download"
                  color="neutral"
                  variant="ghost"
                  :aria-label="`Download ${selectedDownloadModel}`"
                  @click="handleRecommendedModelDownloadClick"
                />

                <template #content>
                  <div class="w-72 space-y-3 p-3 text-sm">
                    <div class="space-y-1">
                      <p class="font-medium text-highlighted">
                        Download model
                      </p>
                      <p class="text-muted">
                        {{ recommendedModelDownloadStatus || 'Ready to download' }}
                      </p>
                    </div>

                    <div class="space-y-1.5">
                      <div class="h-2 overflow-hidden rounded-full bg-muted">
                        <div
                          class="h-full rounded-full bg-primary transition-all"
                          :style="{ width: `${recommendedModelDownloadProgress}%` }"
                        />
                      </div>
                      <div class="flex items-center justify-between gap-2 text-xs text-muted">
                        <span>{{ recommendedModelDownloadProgress }}%</span>
                        <span>
                          {{ recommendedModelDownloadCompletedLabel }} / {{ recommendedModelDownloadTotalLabel }}
                        </span>
                      </div>
                    </div>

                    <p
                      v-if="recommendedModelDownloadDigest"
                      class="truncate text-xs text-muted"
                    >
                      {{ recommendedModelDownloadDigest }}
                    </p>

                    <div
                      v-if="recommendedModelDownloadEvents.length"
                      class="space-y-1 border-t border-default pt-2"
                    >
                      <p
                        v-for="event in recommendedModelDownloadEvents"
                        :key="event"
                        class="truncate text-xs text-muted"
                      >
                        {{ event }}
                      </p>
                    </div>
                  </div>
                </template>
              </UPopover>
              <UButton
                type="button"
                icon="i-lucide-refresh-cw"
                color="neutral"
                variant="ghost"
                :loading="isLoadingModels"
                :disabled="isLoading || isDownloadingRecommendedModel || !selectedProvider"
                aria-label="Refresh Ollama models"
                @click="() => loadDownloadedModels()"
              />
            </UFieldGroup>
          </template>
        </UChatPrompt>
      </template>
    </UChatPalette>

    <template #resize-handle="{ onMouseDown, onTouchStart, onDoubleClick }">
      <UDashboardResizeHandle
        class="order-2 hidden lg:block"
        @mousedown="onMouseDown"
        @touchstart="onTouchStart"
        @dblclick="onDoubleClick"
      />
    </template>
  </UDashboardPanel>
</template>
