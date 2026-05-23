<script setup lang="ts">
useSeoMeta({
  title: 'Graph Viewer',
  ogTitle: 'Graph Viewer - Nest Graph Inspector',
  description: 'View your NestJS dependency graph by auto-connecting to the default inspector origin.'
})

const posthog = usePostHog()
const route = useRoute()
const graphStore = useGraphInspectorStore()
const config = useRuntimeConfig()

const DEFAULT_ORIGIN = 'localhost:53371'
const RETRY_INTERVAL_MS = 2500

const urlInput = ref(DEFAULT_ORIGIN)
const activeOrigin = ref(DEFAULT_ORIGIN)
const userInputError = ref('')
const attemptCount = ref(0)
const isRequestRunning = ref(false)
const isApplyingOrigin = ref(false)
const isNavigating = ref(false)
const isUsingExampleOrigin = ref(false)
const showAdvancedOrigin = ref(false)
const pollingTimer = ref<ReturnType<typeof setInterval> | null>(null)

function loadExample() {
  let base = config.app.baseURL || '/'
  if (!base.endsWith('/')) base += '/'
  urlInput.value = `${window.location.origin}${base}mock-graph`
  isUsingExampleOrigin.value = true
  userInputError.value = ''
  startPolling(urlInput.value)
}

function clearPolling() {
  if (pollingTimer.value) {
    clearInterval(pollingTimer.value)
    pollingTimer.value = null
  }
}

async function tryLoadGraph() {
  if (isRequestRunning.value || isNavigating.value) {
    return
  }

  isRequestRunning.value = true
  attemptCount.value += 1

  try {
    const isLoaded = await graphStore.setInputUrl(activeOrigin.value)
    if (!isLoaded || !graphStore.encodedUrl) {
      return
    }

    isNavigating.value = true
    clearPolling()
    posthog?.capture('graph_auto_connected', {
      url: graphStore.decodedUrl,
      attempts: attemptCount.value
    })
    await navigateTo(`/view/${graphStore.encodedUrl}`)
  } catch {
    userInputError.value = 'Origin is invalid. Use format like localhost:53371 or http://localhost:53371'
    clearPolling()
  } finally {
    isRequestRunning.value = false
  }
}

function startPolling(origin: string) {
  const input = origin.trim()
  if (!input) {
    userInputError.value = 'Please enter a valid origin'
    return
  }

  userInputError.value = ''
  activeOrigin.value = input
  attemptCount.value = 0
  isNavigating.value = false
  clearPolling()

  void tryLoadGraph()
  pollingTimer.value = setInterval(() => {
    void tryLoadGraph()
  }, RETRY_INTERVAL_MS)
}

async function applyOrigin() {
  const input = urlInput.value.trim()
  if (!input) {
    userInputError.value = 'Please enter a valid origin'
    return
  }

  isApplyingOrigin.value = true
  try {
    isUsingExampleOrigin.value = false
    startPolling(input)
    posthog?.capture('graph_origin_changed', {
      origin: input
    })
  } finally {
    isApplyingOrigin.value = false
  }
}

const waitingDescription = computed(() => {
  if (graphStore.shouldShowUpdateModal) {
    return 'Almost there. Please update the package, then keep this page open.'
  }

  if (graphStore.errorMessage) {
    return 'Setup is not ready yet. Keep this page open and it will load automatically once your app is ready.'
  }

  return 'Waiting for your app. This page will open the graph automatically when everything is ready.'
})

onMounted(() => {
  if (route.query.preview == 'true') {
    loadExample()
    return
  }

  startPolling(DEFAULT_ORIGIN)
})

onBeforeUnmount(() => {
  clearPolling()
})

function useDefaultOrigin() {
  urlInput.value = DEFAULT_ORIGIN
  isUsingExampleOrigin.value = false
  userInputError.value = ''
  startPolling(DEFAULT_ORIGIN)
  posthog?.capture('graph_origin_reset_default', {
    origin: DEFAULT_ORIGIN
  })
}
</script>

<template>
  <UContainer class="py-4 flex items-center justify-center min-h-[calc(100vh-140px)]">
    <GraphInspectorUpdateModal />

    <div class="w-full max-w-3xl space-y-5">
      <UCard :ui="{ body: 'p-5 sm:p-6', footer: 'p-5 sm:p-6' }">
        <template #header>
          <div class="space-y-2">
            <div class="flex items-center gap-2">
              <UIcon
                name="i-lucide-loader-circle"
                class="size-5 text-primary animate-spin"
              />
              <h1 class="text-xl sm:text-2xl font-semibold">
                Preparing your graph view
              </h1>
            </div>
            <p class="text-sm text-muted">
              {{ waitingDescription }}
            </p>
          </div>
        </template>

        <div class="space-y-4">
          <UAlert
            icon="i-lucide-info"
            title="Quick setup while waiting"
            color="neutral"
            variant="subtle"
            description="After installation, this page will load automatically. You can also open the viewer link shown in your app console."
          />

          <div class="flex flex-wrap items-center gap-2">
            <UButton
              :icon="showAdvancedOrigin ? 'i-lucide-chevrons-up' : 'i-lucide-chevrons-down'"
              :label="showAdvancedOrigin ? 'Hide Advanced' : 'Advanced'"
              color="neutral"
              variant="soft"
              :disabled="isNavigating"
              @click="showAdvancedOrigin = !showAdvancedOrigin"
            />
            <UButton
              icon="i-lucide-flask-conical"
              label="Load Example"
              color="neutral"
              variant="soft"
              :disabled="isNavigating"
              @click="loadExample"
            />
          </div>

          <UCard
            v-if="showAdvancedOrigin"
            variant="subtle"
          >
            <UFormField
              label="Change origin (optional)"
              :error="userInputError || undefined"
              description="Default origin is localhost:53371. Use this only when your inspector runs on a different host or port."
            >
              <UInput
                v-model="urlInput"
                icon="i-lucide-link"
                placeholder="localhost:53371"
                size="lg"
                :disabled="isRequestRunning || isNavigating"
              />
            </UFormField>

            <div class="mt-3 flex flex-wrap items-center gap-2">
              <UButton
                icon="i-lucide-check"
                label="Apply Origin"
                :loading="isApplyingOrigin"
                :disabled="!urlInput.trim() || isNavigating"
                @click="applyOrigin"
              />
              <UButton
                icon="i-lucide-rotate-ccw"
                label="Use Default"
                color="neutral"
                variant="soft"
                :disabled="isNavigating"
                @click="useDefaultOrigin"
              />
            </div>
          </UCard>
        </div>

        <template #footer>
          <div class="flex flex-wrap items-center gap-2">
            <UButton
              to="/getting-started/installation"
              icon="i-lucide-book-open"
              label="Open Installation Guide"
              color="neutral"
              variant="subtle"
            />
            <UButton
              to="/getting-started/requirements"
              icon="i-lucide-list-checks"
              label="Check Requirements"
              color="neutral"
              variant="subtle"
            />
            <UButton
              v-if="isUsingExampleOrigin"
              to="/view?preview=true"
              icon="i-lucide-external-link"
              label="Preview Demo Route"
              variant="ghost"
            />
          </div>
        </template>
      </UCard>
    </div>
  </UContainer>
</template>
