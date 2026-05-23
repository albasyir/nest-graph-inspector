<script setup lang="ts">
useSeoMeta({
  title: 'Graph Viewer',
  ogTitle: 'Graph Viewer - Nest Graph Inspector',
  description: 'Explore your NestJS dependency graph with an interactive viewer, setup guide, or live demo.'
})

const posthog = usePostHog()
const route = useRoute()
const graphStore = useGraphInspectorStore()
const config = useRuntimeConfig()

const DEFAULT_ORIGIN = 'localhost:53371'
const RETRY_INTERVAL_MS = 2500

const activeOrigin = ref(DEFAULT_ORIGIN)
const attemptCount = ref(0)
const isRequestRunning = ref(false)
const isNavigating = ref(false)
const pollingTimer = ref<ReturnType<typeof setInterval> | null>(null)

function loadExample() {
  let base = config.app.baseURL || '/'
  if (!base.endsWith('/')) base += '/'
  startPolling(`${window.location.origin}${base}mock-graph`)
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
    clearPolling()
  } finally {
    isRequestRunning.value = false
  }
}

function startPolling(origin: string) {
  const input = origin.trim()
  if (!input) {
    return
  }

  activeOrigin.value = input
  attemptCount.value = 0
  isNavigating.value = false
  clearPolling()

  void tryLoadGraph()
  pollingTimer.value = setInterval(() => {
    void tryLoadGraph()
  }, RETRY_INTERVAL_MS)
}

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
</script>

<template>
  <UContainer class="py-4 flex items-center justify-center min-h-[calc(100vh-140px)]">
    <GraphInspectorUpdateModal />

    <div class="w-full max-w-3xl space-y-5">
      <UCard :ui="{ body: 'p-5 sm:p-6' }">
        <template #header>
          <div class="space-y-3">
            <h1 class="text-2xl sm:text-3xl font-semibold">
              New to Nest Graph Inspector?
            </h1>
            <p class="max-w-2xl text-sm sm:text-base text-muted">
              Understand your NestJS modules, providers, and dependencies as an interactive graph. Learn why it helps, connect your own app in minutes, or explore a ready-made demo first.
            </p>
          </div>
        </template>

        <div>
          <div class="grid gap-3 sm:grid-cols-3">
            <UButton
              to="/getting-started"
              icon="i-lucide-circle-help"
              label="Learn Why"
              size="lg"
              color="neutral"
              variant="subtle"
              class="cursor-pointer"
              block
            />
            <UButton
              to="/getting-started/installation"
              icon="i-lucide-book-open"
              label="Install It"
              size="lg"
              color="neutral"
              variant="subtle"
              class="cursor-pointer"
              block
            />
            <UButton
              icon="i-lucide-flask-conical"
              label="Open Demo"
              size="lg"
              variant="solid"
              class="cursor-pointer"
              :disabled="isNavigating"
              block
              @click="loadExample"
            />
          </div>
        </div>
      </UCard>
    </div>
  </UContainer>
</template>
