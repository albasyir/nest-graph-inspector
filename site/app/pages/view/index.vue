<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { redactAccessToken } from '~/utils/inspector-access-token'

useSeoMeta({
  title: 'Graph Viewer',
  ogTitle: 'Graph Viewer - Nest Graph Inspector',
  description:
    'Explore your NestJS dependency graph with an interactive viewer, setup guide, or live demo.'
})

const posthog = usePostHog()
const route = useRoute()
const graphStore = useGraphInspectorStore()
const { shouldShowUpdateModal } = storeToRefs(graphStore)
const config = useRuntimeConfig()

const DEFAULT_ORIGIN = 'localhost:53371'
const RETRY_INTERVAL_MS = 2500

const activeOrigin = ref(DEFAULT_ORIGIN)
const attemptCount = ref(0)
const isRequestRunning = ref(false)
const isNavigating = ref(false)
const isSiteDetected = ref(false)
const shouldNavigateOnLoad = ref(false)
const pollingTimer = ref<ReturnType<typeof setInterval> | null>(null)
let activePollId = 0

async function loadExample() {
  graphStore.showCircularDependencies = true
  graphStore.openModuleDetail = true
  let base = config.app.baseURL || '/'
  if (!base.endsWith('/')) base += '/'

  const exampleUrl = `${window.location.origin}${base}mock-graph`
  const shouldOpenExecutionSequence = route.query['execution-sequence'] === 'true'

  isNavigating.value = true

  // The demo is a graph like any other: put it in the session, then go to a
  // plain viewer page.
  graphStore.setSession(exampleUrl, '')
  await navigateTo(
    shouldOpenExecutionSequence ? '/view/execution-sequence' : '/view/navigator'
  )
}

function clearPolling() {
  if (pollingTimer.value) {
    clearInterval(pollingTimer.value)
    pollingTimer.value = null
  }
}

async function tryLoadGraph(pollId: number) {
  if (isRequestRunning.value || isNavigating.value) {
    return
  }

  isRequestRunning.value = true
  attemptCount.value += 1

  try {
    // A probe, not a load: this page must not disturb the graph the tab is
    // already on, because the visitor can still go Back to it.
    const probe = await graphStore.probeEndpoint(activeOrigin.value)
    if (pollId !== activePollId) {
      return
    }

    if (probe.status === 'legacy') {
      clearPolling()
      return
    }

    // The inspector answered, but it is token-gated: the only thing that hands
    // out a token is the link printed in the application console, so there is
    // nothing more polling can achieve here. Stopping also matters because the
    // library counts repeated invalid tokens per client — polling an endpoint
    // it will keep refusing is the one way this page could get itself blocked.
    if (probe.status === 'requires-token') {
      clearPolling()
      isSiteDetected.value = true
      posthog?.capture('graph_endpoint_detected', {
        url: activeOrigin.value,
        attempts: attemptCount.value,
        requires_access_token: true
      })
      return
    }

    if (probe.status !== 'ready') {
      return
    }

    clearPolling()

    // Only now does this become the graph the tab is on.
    graphStore.setSession(probe.endpointUrl, probe.token)

    if (shouldNavigateOnLoad.value) {
      isNavigating.value = true
      posthog?.capture('graph_auto_connected', {
        url: redactAccessToken(probe.endpointUrl),
        attempts: attemptCount.value
      })
      await navigateTo('/view/navigator')
      return
    }

    isSiteDetected.value = true
    posthog?.capture('graph_endpoint_detected', {
      url: redactAccessToken(probe.endpointUrl),
      attempts: attemptCount.value
    })
  } catch {
    if (pollId === activePollId) {
      clearPolling()
    }
  } finally {
    isRequestRunning.value = false
  }
}

function startPolling(origin: string, navigateOnLoad = false) {
  const input = origin.trim()
  if (!input) {
    return
  }

  activeOrigin.value = input
  attemptCount.value = 0
  isNavigating.value = false
  isSiteDetected.value = false
  shouldNavigateOnLoad.value = navigateOnLoad
  clearPolling()

  const pollId = ++activePollId
  void tryLoadGraph(pollId)
  pollingTimer.value = setInterval(() => {
    void tryLoadGraph(pollId)
  }, RETRY_INTERVAL_MS)
}

onMounted(() => {
  if (route.query.preview == 'true') {
    loadExample()
    return
  }

  graphStore.openModuleDetail = false
  startPolling(DEFAULT_ORIGIN)
})

onBeforeUnmount(() => {
  activePollId += 1
  clearPolling()
})

watch(shouldShowUpdateModal, (visible) => {
  if (visible) {
    clearPolling()
  }
})
</script>

<template>
  <UContainer
    class="py-4 flex items-center justify-center min-h-[calc(100vh-140px)]"
  >
    <GraphInspectorUpdateModal />

    <div class="w-full max-w-3xl space-y-5">
      <UAlert
        v-if="isSiteDetected"
        icon="i-lucide-circle-check"
        color="success"
        variant="subtle"
        title="Nest Graph Inspector detected"
        description="Open your NestJS app console and click the Graph Viewer link printed there."
      />

      <UCard :ui="{ body: 'p-5 sm:p-6' }">
        <template #header>
          <div class="space-y-3">
            <h1 class="text-2xl sm:text-3xl font-semibold">
              New to Nest Graph Inspector?
            </h1>
            <p class="max-w-2xl text-sm sm:text-base text-muted">
              Understand your NestJS modules, providers, and dependencies as an
              interactive graph. Learn why it helps, connect your own app in
              minutes, or explore a ready-made demo first.
            </p>
          </div>
        </template>

        <div>
          <div class="grid gap-3 sm:grid-cols-3">
            <UButton
              icon="i-lucide-circle-help"
              label="Learn Why"
              to="/getting-started"
              size="lg"
              color="neutral"
              variant="subtle"
              class="cursor-pointer"
              :disabled="isSiteDetected"
              block
            />
            <UButton
              icon="i-lucide-book-open"
              label="Install It"
              to="/getting-started/installation"
              size="lg"
              color="neutral"
              variant="subtle"
              class="cursor-pointer"
              :disabled="isSiteDetected"
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
