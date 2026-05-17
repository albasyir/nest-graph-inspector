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

const OLLAMA_PROXY_PATH = '/ollama'
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'
const OLLAMA_THINKING_EFFORT = 'low'
const OLLAMA_THINKING_FALLBACK_CHAR_LIMIT = 3000
const RECOMMENDED_MODEL = 'qwen3.5:4b'

class OllamaThinkingFallbackError extends Error {
  constructor() {
    super('Ollama thinking stream did not produce answer content quickly enough.')
  }
}

const open = ref(false)
const prompt = ref('')
const isLoading = ref(false)
const isLoadingModels = ref(false)
const hasLoadedModels = ref(false)
const isDownloadingRecommendedModel = ref(false)
const modelError = ref('')
const isOllamaUnavailable = ref(false)
const selectedProvider = ref('')
const selectedModel = ref('')
const downloadedModels = ref<string[]>([])
const messages = ref<ChatMessage[]>([
  {
    role: 'assistant',
    content: 'Hi, I can help you inspect this NestJS graph. Ask me to trace a dependency, explain a module, or find where a provider is used.'
  }
])

const posthog = usePostHog()
const graphStore = useGraphInspectorStore()

const providerItems = [
  {
    label: 'Ollama',
    value: 'ollama',
    icon: 'i-simple-icons-ollama'
  }
]

const modelItems = computed(() => downloadedModels.value.map(model => ({
  label: model,
  value: model,
  icon: 'i-lucide-brain'
})))

const selectedProviderIcon = computed(() => {
  return providerItems.find(provider => provider.value === selectedProvider.value)?.icon
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

async function loadDownloadedModels() {
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
      return
    }

    if (!completionModels.includes(selectedModel.value)) {
      selectedModel.value = completionModels[0] || ''
    }
  } catch (error) {
    selectedModel.value = ''
    downloadedModels.value = []
    hasLoadedModels.value = false
    isOllamaUnavailable.value = true
    modelError.value = error instanceof Error ? error.message : 'Unable to load Ollama models.'
  } finally {
    isLoadingModels.value = false
  }
}

function handleOpenChange(value: boolean) {
  open.value = value

  if (value) {
    graphStore.fetchMarkdown()

    posthog?.capture('Graph AI Chat Opened', {
      url: graphStore.decodedUrl
    })
  }
}

watch(selectedProvider, (provider) => {
  selectedModel.value = ''
  downloadedModels.value = []
  hasLoadedModels.value = false
  modelError.value = ''
  isOllamaUnavailable.value = false

  if (provider === 'ollama') {
    loadDownloadedModels()
  }
})

async function downloadRecommendedModel() {
  if (!import.meta.client || isDownloadingRecommendedModel.value || selectedProvider.value !== 'ollama') {
    return
  }

  isDownloadingRecommendedModel.value = true
  modelError.value = ''
  isOllamaUnavailable.value = false

  try {
    const response = await fetch(getOllamaApiUrl('/api/pull'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: RECOMMENDED_MODEL,
        stream: false
      })
    })

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status} while downloading ${RECOMMENDED_MODEL}`)
    }

    await loadDownloadedModels()
  } catch (error) {
    const message = error instanceof Error ? error.message : `Unable to download ${RECOMMENDED_MODEL}.`

    modelError.value = message
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
    messages.value.push({
      role: 'assistant',
      content: 'Select a provider before sending a message.'
    })
    return
  }

  if (!selectedModel.value) {
    messages.value.push({
      role: 'assistant',
      content: 'Select a downloaded Ollama model before sending a message.'
    })
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
  <UModal
    :open="open"
    fullscreen
    title="AI Chat"
    description="Graph-aware assistant"
    @update:open="handleOpenChange"
  >
    <UButton
      icon="i-lucide-message-circle"
      label="AI Chat"
      variant="outline"
      size="sm"
    />

    <template #body>
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
    </template>

    <template #footer>
      <UChatPrompt
        v-model="prompt"
        icon="i-lucide-sparkles"
        placeholder="Ask about this graph..."
        variant="subtle"
        :rows="1"
        :maxrows="4"
        :disabled="isLoading || isDownloadingRecommendedModel || !selectedProvider || !selectedModel"
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
              :items="providerItems"
              :icon="selectedProviderIcon"
              placeholder="Select provider"
              variant="ghost"
            />
            <USelect
              v-model="selectedModel"
              :items="modelItems"
              :loading="isLoadingModels || isDownloadingRecommendedModel"
              :disabled="!selectedProvider"
              icon="i-lucide-brain"
              placeholder="Select model"
              variant="ghost"
            />
            <UButton
              type="button"
              icon="i-lucide-refresh-cw"
              color="neutral"
              variant="ghost"
              :loading="isLoadingModels"
              :disabled="isLoading || isDownloadingRecommendedModel || !selectedProvider"
              aria-label="Refresh Ollama models"
              @click="loadDownloadedModels"
            />
          </UFieldGroup>

          <UAlert
            v-if="isOllamaUnavailable"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Ollama unavailable"
            description="Please install Ollama and start it before selecting a model."
          >
            <template #actions>
              <UButton
                label="Install Ollama"
                color="neutral"
                variant="link"
                size="xs"
                :to="OLLAMA_DOWNLOAD_URL"
                target="_blank"
                rel="noopener noreferrer"
                external
              />
            </template>
          </UAlert>

          <UAlert
            v-else-if="modelError"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="Model error"
            :description="modelError"
          />

          <UAlert
            v-if="shouldShowRecommendedModelDownload"
            color="neutral"
            variant="subtle"
            icon="i-lucide-download"
            title="No completion model found"
            :description="`Download ${RECOMMENDED_MODEL} to start chatting.`"
          >
            <template #actions>
              <UButton
                type="button"
                :label="`Download ${RECOMMENDED_MODEL}`"
                color="neutral"
                variant="link"
                size="xs"
                :loading="isDownloadingRecommendedModel"
                @click="downloadRecommendedModel"
              />
            </template>
          </UAlert>
        </template>
      </UChatPrompt>
    </template>
  </UModal>
</template>
