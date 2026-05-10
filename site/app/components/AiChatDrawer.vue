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

const OLLAMA_BASE_URL = 'http://localhost:11434'
const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'
const RECOMMENDED_MODEL = 'qwen3.5:4b'

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

async function loadModelCapabilities(model: string) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/show`, {
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
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`)
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
    const response = await fetch(`${OLLAMA_BASE_URL}/api/pull`, {
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
    '- Before the final answer, include a short visible reasoning summary inside `<reasoning>...</reasoning>`.',
    '- The reasoning summary should explain what graph facts you checked, not private chain-of-thought.',
    '- Put the user-facing Markdown answer inside `<answer>...</answer>`.',
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
  const reasoning = getTaggedContent(content, 'reasoning')
  const answer = getTaggedContent(content, 'answer')

  if (answer) {
    return {
      reasoning,
      content: answer
    }
  }

  return {
    reasoning,
    content: content.replace(/<reasoning>[\s\S]*?<\/reasoning>/i, '').trim()
  }
}

function parseStreamingAssistantReply(content: string) {
  const lowerContent = content.toLowerCase()
  const reasoningOpenTag = '<reasoning>'
  const reasoningCloseTag = '</reasoning>'
  const answerOpenTag = '<answer>'
  const answerCloseTag = '</answer>'
  const reasoningOpenIndex = lowerContent.indexOf(reasoningOpenTag)
  const reasoningCloseIndex = lowerContent.indexOf(reasoningCloseTag)
  const answerOpenIndex = lowerContent.indexOf(answerOpenTag)
  const answerCloseIndex = lowerContent.indexOf(answerCloseTag)

  const reasoning = reasoningOpenIndex === -1
    ? ''
    : content
        .slice(
          reasoningOpenIndex + reasoningOpenTag.length,
          reasoningCloseIndex === -1 ? content.length : reasoningCloseIndex
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

  if (reasoningCloseIndex !== -1) {
    return {
      reasoning,
      content: content
        .slice(reasoningCloseIndex + reasoningCloseTag.length)
        .replace(new RegExp(answerOpenTag, 'gi'), '')
        .replace(new RegExp(answerCloseTag, 'gi'), '')
        .trim()
    }
  }

  return {
    reasoning,
    content: reasoningOpenIndex === -1
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

function getAgentMessages() {
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
  const assistantMessage: ChatMessage = {
    role: 'assistant',
    content: '',
    reasoning: '',
    reasoningStreaming: true
  }

  messages.value.push(assistantMessage)

  try {
    await graphStore.fetchMarkdown()

    const [{ ChatOllama }, { SystemMessage, HumanMessage, AIMessage }] = await Promise.all([
      import('@langchain/ollama'),
      import('@langchain/core/messages')
    ])

    const model = new ChatOllama({
      baseUrl: OLLAMA_BASE_URL,
      model: selectedModel.value,
      temperature: 0.2,
      streaming: true,
      think: true
    })

    const modelMessages = [
      new SystemMessage(systemPrompt.value),
      ...getAgentMessages().map((message) => {
        return message.role === 'user'
          ? new HumanMessage(message.content)
          : new AIMessage(message.content)
      })
    ]

    let streamedContent = ''

    for await (const chunk of await model.stream(modelMessages)) {
      const reasoningDelta = getStreamReasoningText(chunk)
      const contentDelta = getContentText((chunk as { content?: unknown }).content)

      if (reasoningDelta) {
        assistantMessage.reasoning = `${assistantMessage.reasoning || ''}${reasoningDelta}`
      }

      if (contentDelta) {
        streamedContent += contentDelta

        const parsedReply = parseStreamingAssistantReply(streamedContent)
        if (parsedReply.reasoning && !reasoningDelta) {
          assistantMessage.reasoning = parsedReply.reasoning
        }

        assistantMessage.content = parsedReply.content
      }
    }

    const parsedReply = parseAssistantReply(streamedContent)

    if (!assistantMessage.reasoning && parsedReply.reasoning) {
      assistantMessage.reasoning = parsedReply.reasoning
    }
    assistantMessage.reasoningStreaming = false
    assistantMessage.content = assistantMessage.content || parsedReply.content || 'I could not produce a response from Ollama.'
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'

    assistantMessage.reasoning = ''
    assistantMessage.reasoningStreaming = false
    assistantMessage.content = `I could not reach Ollama from the browser. Make sure Ollama is running at ${OLLAMA_BASE_URL}, the selected model is available, and Ollama allows this site origin. Error: ${message}`
  } finally {
    isLoading.value = false
  }
}
</script>

<template>
  <UDrawer
    :open="open"
    direction="right"
    title="AI Chat"
    description="Graph-aware assistant"
    :ui="{
      content: 'w-full sm:max-w-md',
      body: 'flex min-h-0 flex-1 flex-col gap-4 p-0',
      footer: 'p-4'
    }"
    @update:open="handleOpenChange"
  >
    <UButton
      icon="i-lucide-message-circle"
      label="AI Chat"
      variant="outline"
      size="sm"
    />

    <template #body>
      <div class="flex min-h-0 flex-1 flex-col">
        <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
          <div
            v-for="(message, index) in messages"
            :key="index"
            class="flex"
            :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
          >
            <div
              class="max-w-[85%] rounded-lg px-3 py-2 text-sm"
              :class="message.role === 'user'
                ? 'bg-primary text-inverted'
                : 'bg-muted text-highlighted'"
            >
              <UChatReasoning
                v-if="message.reasoning || message.reasoningStreaming"
                :text="message.reasoning"
                :streaming="message.reasoningStreaming"
                icon="i-lucide-brain"
                chevron="leading"
                :auto-close-delay="1000"
                class="mb-2"
                :ui="{
                  body: 'max-h-40 text-xs'
                }"
              />

              <MDC
                v-if="message.content"
                :value="message.content"
                tag="div"
                class="chat-markdown"
                :class="message.role === 'user' ? 'chat-markdown-inverted' : undefined"
              />
            </div>
          </div>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="space-y-3">
        <UChatPrompt
          v-model="prompt"
          icon="i-lucide-sparkles"
          placeholder="Ask about this graph..."
          variant="subtle"
          :rows="1"
          :maxrows="4"
          :disabled="isLoading || isDownloadingRecommendedModel || !selectedProvider || !selectedModel"
          class="w-full"
          @submit="handleSubmit"
        >
          <UChatPromptSubmit
            color="neutral"
            :status="isLoading ? 'submitted' : 'ready'"
          />

          <template #footer>
            <div class="flex w-full flex-col gap-2">
              <div class="flex flex-wrap items-center gap-2">
                <USelect
                  v-model="selectedProvider"
                  :items="providerItems"
                  :icon="selectedProviderIcon"
                  placeholder="Select provider"
                  variant="ghost"
                  class="w-32"
                />
                <USelect
                  v-model="selectedModel"
                  :items="modelItems"
                  :loading="isLoadingModels || isDownloadingRecommendedModel"
                  :disabled="!selectedProvider"
                  icon="i-lucide-brain"
                  placeholder="Select model"
                  variant="ghost"
                  class="min-w-40 flex-1"
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
              </div>

              <div
                v-if="isOllamaUnavailable"
                class="flex flex-wrap items-center gap-2 text-xs text-error"
              >
                <span>Please install Ollama and start it before selecting a model.</span>
                <UButton
                  label="Install Ollama"
                  color="neutral"
                  variant="link"
                  size="xs"
                  :to="OLLAMA_DOWNLOAD_URL"
                  target="_blank"
                  rel="noopener noreferrer"
                  external
                  class="p-0"
                />
              </div>
              <p
                v-else-if="modelError"
                class="text-xs text-error"
              >
                {{ modelError }}
              </p>
              <div
                v-if="shouldShowRecommendedModelDownload"
                class="flex flex-wrap items-center gap-2 text-xs text-muted"
              >
                <span>No completion model found. Download {{ RECOMMENDED_MODEL }} to start chatting.</span>
                <UButton
                  type="button"
                  :label="`Download ${RECOMMENDED_MODEL}`"
                  color="neutral"
                  variant="link"
                  size="xs"
                  :loading="isDownloadingRecommendedModel"
                  class="p-0"
                  @click="downloadRecommendedModel"
                />
              </div>
            </div>
          </template>
        </UChatPrompt>
      </div>
    </template>
  </UDrawer>
</template>

<style scoped>
.chat-markdown {
  overflow-wrap: anywhere;
}

.chat-markdown :deep(:first-child) {
  margin-top: 0;
}

.chat-markdown :deep(:last-child) {
  margin-bottom: 0;
}

.chat-markdown :deep(p),
.chat-markdown :deep(ul),
.chat-markdown :deep(ol),
.chat-markdown :deep(pre),
.chat-markdown :deep(blockquote),
.chat-markdown :deep(table) {
  margin: 0.5rem 0;
}

.chat-markdown :deep(ul),
.chat-markdown :deep(ol) {
  padding-left: 1rem;
}

.chat-markdown :deep(ul) {
  list-style: disc;
}

.chat-markdown :deep(ol) {
  list-style: decimal;
}

.chat-markdown :deep(code) {
  border-radius: 0.25rem;
  background: color-mix(in oklab, var(--ui-bg-inverted) 8%, transparent);
  padding: 0.0625rem 0.25rem;
  font-size: 0.8125rem;
}

.chat-markdown :deep(pre) {
  overflow-x: auto;
  border-radius: 0.375rem;
  background: color-mix(in oklab, var(--ui-bg-inverted) 8%, transparent);
  padding: 0.625rem;
}

.chat-markdown :deep(pre code) {
  background: transparent;
  padding: 0;
}

.chat-markdown :deep(a) {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.chat-markdown-inverted :deep(code),
.chat-markdown-inverted :deep(pre) {
  background: rgb(255 255 255 / 0.16);
}
</style>
