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
const demoStore = useNodepodDemoStore()
const { shouldShowUpdateModal } = storeToRefs(graphStore)

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

/**
 * Starts the demo application inside this browser tab and opens the viewer on
 * the endpoint it reports. There is no fixture behind it: the graph, the
 * direct-run endpoint, and the history all come from that running application.
 */
async function loadExample() {
  graphStore.showCircularDependencies = true
  graphStore.openModuleDetail = true
  // Stopping the interval is not enough: a probe already awaiting an answer
  // would still resolve during the boot and write its own endpoint over the
  // demo's, so the poll it belongs to is retired outright.
  activePollId += 1
  clearPolling()

  const started = await demoStore.start()

  if (!started) {
    posthog?.capture('graph_demo_start_failed', {
      reason: demoStore.errorMessage
    })

    // The page was watching for a local inspector before the demo was asked
    // for, and it still is: a demo that would not start is not a reason to stop
    // looking for the developer's own application.
    startPolling(activeOrigin.value)

    return
  }

  const shouldOpenExecutionSequence = route.query['execution-sequence'] === 'true'

  posthog?.capture('graph_demo_started', {
    revision: demoStore.manifest?.revision
  })

  isNavigating.value = true

  // The demo is a graph like any other: put it in the session, then go to a
  // plain viewer page. The demo and this site are built from the same commit,
  // so the version acknowledgement the viewer asks for elsewhere has nothing
  // to add here.
  graphStore.setSession(demoStore.endpointUrl, demoStore.accessToken)
  graphStore.trustEndpointVersion(demoStore.endpointUrl)
  await navigateTo(
    shouldOpenExecutionSequence ? '/view/execution-sequence' : '/view/navigator'
  )
}

/**
 * Last few lines the demo application printed, so a slow start is visibly a
 * real application starting rather than a stalled page.
 */
const demoConsole = computed(() => demoStore.logLines.slice(-6).join('\n'))

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
    void loadExample()
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
      <UCard
        v-if="demoStore.isBusy"
        :ui="{ body: 'p-5 sm:p-6 space-y-3' }"
      >
        <div class="flex items-center gap-3">
          <UIcon
            name="i-lucide-loader-circle"
            class="size-5 shrink-0 animate-spin text-primary"
          />
          <p class="text-sm font-medium">
            {{ demoStore.statusLabel }}
          </p>
        </div>
        <UProgress
          v-if="demoStore.status === 'downloading' && demoStore.totalBytes"
          :model-value="Math.round(demoStore.downloadProgress * 100)"
        />
        <pre
          v-if="demoConsole"
          data-testid="demo-console"
          class="max-h-56 overflow-auto rounded-lg bg-muted/50 p-3 text-xs text-muted whitespace-pre-wrap"
        >{{ demoConsole }}</pre>
        <p class="text-xs text-muted">
          The demo is this repository's NestJS application, running in your
          browser on
          <NuxtLink
            to="https://github.com/ScelarOrg/Nodepod"
            target="_blank"
            class="text-primary font-medium"
          >
            nodepod
          </NuxtLink>.
        </p>
      </UCard>

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
              minutes, or run the demo application right here in your browser.
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
              :label="demoStore.isBusy ? 'Starting Demo…' : 'Open Demo'"
              size="lg"
              variant="solid"
              class="cursor-pointer"
              :loading="demoStore.isBusy"
              :disabled="isNavigating || demoStore.isBusy"
              block
              @click="loadExample"
            />
          </div>
        </div>
      </UCard>
    </div>
  </UContainer>
</template>
