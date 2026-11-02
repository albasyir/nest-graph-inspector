<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { describeGraphEndpoint } from '~/utils/graph-viewer-analytics'
import { canOpenWithoutAccessToken } from '~/utils/inspector-access-token'
import {
  resolveViewerLandingAction,
  resolveViewerLandingPath
} from '~/utils/viewer-landing'

useSeoMeta({
  title: 'Graph Viewer',
  ogTitle: 'Graph Viewer - Nest Graph Inspector',
  description:
    'Explore your NestJS dependency graph with an interactive viewer: open a graph file, connect your application, or load the example.'
})

const posthog = usePostHog()
const route = useRoute()
const graphStore = useGraphInspectorStore()
const demoStore = useNodepodDemoStore()
const { shouldShowUpdateModal, expiredGraphFile } = storeToRefs(graphStore)
const fileOpener = useGraphFileOpener()
const { error: fileError, isReading: isReadingFile } = fileOpener

const DEFAULT_ORIGIN = 'localhost:53371'
const RETRY_INTERVAL_MS = 2500

const activeOrigin = ref(DEFAULT_ORIGIN)
const attemptCount = ref(0)
const isRequestRunning = ref(false)
const isNavigating = ref(false)
const isSiteDetected = ref(false)
const shouldNavigateOnLoad = ref(false)
/** Whether the visitor asked this page for the demo, retries included. */
const wasDemoRequested = ref(false)
/**
 * The tab's demo is running, or on its way up: what `?preview=true` joins, and
 * what a tab on no graph of the visitor's own choosing joins too.
 */
const isDemoActive = computed(() => demoStore.isRunning || demoStore.isBusy)
/**
 * Whether this page is on its way to the viewer without a click: joining the
 * demo this document is running or starting, opening the demo's static graph
 * for a preview that has not loaded the example, or returning to the tab's own
 * graph.
 *
 * Seeded on the landing card wherever the page is rendered on the server or
 * hydrated over that render — the server cannot read the tab's session, and
 * the prerendered page has no query to read either — so the two agree, and
 * `openOnArrival` moves on once mounted. Reached from another page of the same
 * document, it is seeded from the graph the tab is on in memory, which is what
 * `openOnArrival` restores, so a page about to join the demo opens straight on
 * the loading card rather than flashing the landing card first. Only a session
 * a reload left behind, which nothing in memory holds yet, is read on mount.
 */
const isAutoOpening = ref(
  import.meta.client
    && !useNuxtApp().isHydrating
    && resolveViewerLandingAction({
      query: route.query,
      restoredEndpointUrl: graphStore.endpointUrl,
      canOpenRestoredSession: graphStore.hasAccessToken
        || canOpenWithoutAccessToken(graphStore.endpointUrl, window.location.origin),
      restoredGraphFile: graphStore.fileSource?.kind,
      isDemoActive: isDemoActive.value,
      viewerOrigin: window.location.origin
    }).kind !== 'manual'
)
/** Why the demo's static graph could not be opened for `?preview=true`. */
const exampleError = ref('')
const pollingTimer = ref<ReturnType<typeof setInterval> | null>(null)
let activePollId = 0
/** Retires a demo start the visitor cancelled while it was still booting. */
let activeDemoRequestId = 0
/** Retires an example graph still loading once the visitor opens a file. */
let activeExampleRequestId = 0

/**
 * Opens the viewer on the demo application running in this tab.
 *
 * Reached once the demo this page asked for — clicked for, or joined because
 * this document is running it — is up, and again from the retry in the error
 * dialog, which is mounted for the whole app and can only start the
 * application, so what asking for it was for is this page's to finish.
 */
async function openDemo() {
  if (isNavigating.value) {
    return
  }

  isNavigating.value = true

  // A failed start left this page watching for a local inspector again, and
  // stopping the interval is not enough: a probe already awaiting an answer
  // would still resolve and write its own endpoint over the demo's, so the
  // poll it belongs to is retired outright.
  activePollId += 1
  clearPolling()

  // The demo is a graph like any other: put it in the session, then go to a
  // plain viewer page. The middleware puts the demo in place the same way when
  // a viewer page is reached without coming through here.
  graphStore.setDemoSession(demoStore.endpointUrl, demoStore.accessToken)
  // Replaced rather than pushed, like every hand-off from this page: Back from
  // the viewer should leave it, not return to the card that opened it — which,
  // reached from a preview, would only join the demo and send the visitor
  // forward again.
  await navigateTo(resolveViewerLandingPath(route.query), { replace: true })
}

/**
 * Waits for the demo application inside this browser tab and opens the viewer
 * on the endpoint it reports. There is no fixture behind it: the graph, the
 * direct-run endpoint, and the history all come from that running application.
 *
 * `start` boots it, and is only ever the visitor's click on "Load Example";
 * `join` waits for the demo this document is already running or starting — a
 * preview's, or one started here earlier — and never boots one.
 */
async function requestDemo(how: 'start' | 'join') {
  wasDemoRequested.value = true
  activePollId += 1
  clearPolling()

  const requestId = ++activeDemoRequestId
  const started = await (how === 'start' ? demoStore.start() : demoStore.join())

  if (requestId !== activeDemoRequestId) {
    return
  }

  if (started) {
    await openDemo()

    return
  }

  isAutoOpening.value = false
  posthog?.capture('graph_demo_start_failed', {
    reason: demoStore.errorMessage
  })

  // A demo that would not come up is not a reason to stop looking for the
  // developer's own application, so the page goes back to watching for it.
  startPolling(activeOrigin.value)
}

/**
 * Stops a demo this page is still waiting on and goes back to the landing card.
 *
 * Getting it up takes a while — a download, then a boot — and the visitor may
 * change their mind on the way: connect their own application instead, or
 * keep the download off a metered connection.
 */
function cancelDemo() {
  activeDemoRequestId += 1
  wasDemoRequested.value = false
  isAutoOpening.value = false
  demoStore.stop()
  graphStore.openModuleDetail = false
  startPolling(activeOrigin.value)
}

/**
 * Decides, once the tab's session is readable, whether to join the demo this
 * document is running, open the demo's static graph, return to the graph the
 * tab was already on, or wait on the landing card. It never starts the demo:
 * that takes the visitor's click.
 */
function openOnArrival() {
  const source = graphStore.restoreGraphSource()
  const restoredEndpointUrl = source === 'endpoint' ? graphStore.endpointUrl : ''
  const action = resolveViewerLandingAction({
    query: route.query,
    restoredEndpointUrl,
    canOpenRestoredSession: graphStore.hasAccessToken
      || canOpenWithoutAccessToken(restoredEndpointUrl, window.location.origin),
    restoredGraphFile: graphStore.fileSource?.kind,
    isDemoActive: isDemoActive.value,
    viewerOrigin: window.location.origin
  })

  if (action.kind === 'join-demo') {
    isAutoOpening.value = true
    void requestDemo('join')
    return
  }

  if (action.kind === 'open-example') {
    isAutoOpening.value = true
    void openExampleOnArrival()
    return
  }

  if (action.kind === 'open-session') {
    isAutoOpening.value = true
    isNavigating.value = true
    void navigateTo(action.path, { replace: true })
    return
  }

  isAutoOpening.value = false
  graphStore.openModuleDetail = false

  // A tab on a graph file came here to open another, or to look around; it is
  // not waiting for an application, and a local inspector found meanwhile
  // would take the file's place in the session.
  if (source !== 'file') {
    startPolling(DEFAULT_ORIGIN)
  }
}

/**
 * Opens the demo's static graph, as `?preview=true` does for a preview that
 * has not loaded the example. Nothing is booted; when the graph cannot be
 * read, the landing card says so beside Load Example.
 */
async function openExampleOnArrival() {
  const requestId = ++activeExampleRequestId
  const isCurrent = () => requestId === activeExampleRequestId

  graphStore.showCircularDependencies = true
  graphStore.openModuleDetail = true
  isNavigating.value = true

  if (await fileOpener.openExample({ beforeOpen: isCurrent })) {
    return
  }

  // A file the visitor opened while the example was loading took its place.
  if (!isCurrent()) {
    return
  }

  exampleError.value = fileError.value
  fileOpener.clearError()
  isNavigating.value = false
  isAutoOpening.value = false
  graphStore.openModuleDetail = false
  startPolling(DEFAULT_ORIGIN)
}

/**
 * Leaves the landing card for a graph file the visitor chose, once it has
 * proved to be one: whatever this page was waiting on — a demo it asked for,
 * the example loading, a local inspector — is let go, so it cannot take the
 * file's place when it answers. A file that fails lets all of it carry on.
 */
function prepareForGraphFile(): true {
  activeDemoRequestId += 1
  wasDemoRequested.value = false
  activeExampleRequestId += 1
  activePollId += 1
  clearPolling()
  exampleError.value = ''

  return true
}

/** The visitor has read the notice about a file the reload could not keep. */
function dismissExpiredGraphFile(open: boolean) {
  if (!open) {
    graphStore.expiredGraphFile = null
  }
}

const fileInput = useTemplateRef<HTMLInputElement>('fileInput')

/** Opens the system file picker: the click and keyboard way to a graph file. */
function chooseGraphFile() {
  fileOpener.clearError()
  fileInput.value?.click()
}

async function openGraphFile(file: File | undefined) {
  if (!file || isReadingFile.value) {
    return
  }

  // Not opened: the error is under the drop zone, and nothing else changed.
  await fileOpener.openFile(file, { beforeOpen: prepareForGraphFile })
}

function handleFileChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]

  // Cleared, so choosing the same file again — fixed on disk — still opens it.
  input.value = ''
  void openGraphFile(file)
}

/**
 * Whether a file is being dragged over the page. A file dropped anywhere on
 * the page opens; without this, the browser would navigate to it instead.
 * Only drags that carry files count — a dragged link or text selection is
 * left to the browser.
 */
const isDraggingFile = ref(false)
let dragDepth = 0

function carriesFiles(event: DragEvent) {
  return Boolean(event.dataTransfer?.types.includes('Files'))
}

useEventListener('dragenter', (event: DragEvent) => {
  if (!carriesFiles(event)) {
    return
  }

  event.preventDefault()
  dragDepth += 1
  isDraggingFile.value = true
})

useEventListener('dragover', (event: DragEvent) => {
  if (!carriesFiles(event)) {
    return
  }

  event.preventDefault()

  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
})

useEventListener('dragleave', (event: DragEvent) => {
  if (!carriesFiles(event)) {
    return
  }

  dragDepth = Math.max(0, dragDepth - 1)
  isDraggingFile.value = dragDepth > 0
})

useEventListener('drop', (event: DragEvent) => {
  if (!carriesFiles(event)) {
    return
  }

  event.preventDefault()
  dragDepth = 0
  isDraggingFile.value = false

  const file = event.dataTransfer?.files[0]
  if (file) {
    void openGraphFile(file)
  } else {
    void fileOpener.openDrop(event.dataTransfer, { beforeOpen: prepareForGraphFile })
  }
})

/** What the loading card says while the page is opening the viewer. */
const openingLabel = computed(() =>
  demoStore.isBusy ? demoStore.statusLabel : 'Opening the graph viewer…'
)

/**
 * The same, for screen readers: the stage alone, so a download is announced
 * once rather than at every percent.
 */
const openingAnnouncement = computed(() =>
  demoStore.status === 'downloading'
    ? 'Downloading the demo application…'
    : openingLabel.value
)

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
        url: describeGraphEndpoint(probe.endpointUrl).graph_url,
        attempts: attemptCount.value
      })
      await navigateTo('/view/navigator')
      return
    }

    isSiteDetected.value = true
    posthog?.capture('graph_endpoint_detected', {
      url: describeGraphEndpoint(probe.endpointUrl).graph_url,
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

  // A tab on a graph file is not waiting for an application, and one found
  // meanwhile would take the file's place in the session.
  if (!input || graphStore.isFileSource) {
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

onMounted(openOnArrival)

onBeforeUnmount(() => {
  activePollId += 1
  clearPolling()
  // An error is about the file just tried; coming back later starts clean.
  fileOpener.clearError()
})

// A retry from the error dialog boots the application without knowing which
// flow it belongs to, so an application that comes up while this page is the
// one that asked for it is the visitor still waiting to be taken to the viewer.
watch(() => demoStore.status, (status) => {
  if (status === 'ready' && wasDemoRequested.value) {
    void openDemo()
  }
})

// The viewer's Close Graph comes here first and closes the file after: once it
// has, the landing card watches for a local inspector like any other.
watch(() => graphStore.isFileSource, (isFileSource) => {
  if (!isFileSource && !isAutoOpening.value && !wasDemoRequested.value && !pollingTimer.value) {
    startPolling(activeOrigin.value)
  }
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
        v-if="isAutoOpening || demoStore.isBusy"
        data-testid="demo-loading"
        :aria-busy="true"
        :ui="{ body: 'p-5 sm:p-6 space-y-3' }"
      >
        <div class="flex items-center gap-3">
          <UIcon
            name="i-lucide-loader-circle"
            class="size-5 shrink-0 motion-safe:animate-spin text-primary"
            aria-hidden="true"
          />
          <p
            aria-hidden="true"
            class="min-w-0 flex-1 text-sm font-medium tabular-nums"
          >
            {{ openingLabel }}
          </p>
          <span
            role="status"
            class="sr-only"
          >{{ openingAnnouncement }}</span>
          <UButton
            v-if="demoStore.isBusy && wasDemoRequested"
            label="Cancel"
            aria-label="Cancel starting the demo"
            size="sm"
            color="neutral"
            variant="ghost"
            class="shrink-0 cursor-pointer"
            @click="cancelDemo"
          />
        </div>
        <UProgress
          v-if="demoStore.status === 'downloading' && demoStore.totalBytes"
          :model-value="Math.round(demoStore.downloadProgress * 100)"
          aria-label="Demo download progress"
        />
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
        v-if="expiredGraphFile"
        class="ph-no-capture"
        icon="i-lucide-file-clock"
        color="warning"
        variant="subtle"
        :title="`${expiredGraphFile.name} was not kept for the reload`"
        description="It is too large to keep in this tab. Open it again to carry on where you were."
        close
        @update:open="dismissExpiredGraphFile"
      />

      <UAlert
        v-if="exampleError"
        icon="i-lucide-circle-alert"
        color="error"
        variant="subtle"
        title="The example graph could not be opened"
        :description="`${exampleError} Load Example starts the demo application instead.`"
      />

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
              minutes, open a graph file you exported, or load the example
              application right here in your browser.
            </p>
          </div>
        </template>

        <div class="space-y-5">
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
              :label="demoStore.isBusy ? 'Loading Example…' : 'Load Example'"
              size="lg"
              variant="solid"
              class="cursor-pointer"
              :loading="demoStore.isBusy"
              :disabled="isNavigating || isAutoOpening || demoStore.isBusy"
              block
              @click="requestDemo('start')"
            />
          </div>

          <!-- A graph file is read here and goes nowhere else, so what it is
               called and what it says stay out of analytics: `ph-no-capture`
               keeps PostHog's click capture and session replay off this. -->
          <section
            aria-labelledby="graph-file-heading"
            class="ph-no-capture"
          >
            <div
              data-testid="graph-file-drop-zone"
              class="flex flex-col gap-4 rounded-lg border border-dashed p-4 transition-colors sm:flex-row sm:items-center sm:justify-between sm:p-5"
              :class="isDraggingFile ? 'border-primary bg-primary/5' : 'border-accented'"
            >
              <div class="min-w-0 space-y-1">
                <h2
                  id="graph-file-heading"
                  class="text-sm font-semibold text-highlighted"
                >
                  Open a Graph File
                </h2>
                <p class="text-sm text-muted text-pretty">
                  Drop the JSON that
                  <code class="text-xs">npx nest-graph-inspector export</code>
                  writes, or choose it. It is read in this browser and never
                  uploaded.
                </p>
              </div>
              <UButton
                icon="i-lucide-folder-open"
                :label="isReadingFile ? 'Reading File…' : 'Open Graph File'"
                size="lg"
                color="neutral"
                variant="outline"
                class="shrink-0 cursor-pointer justify-center"
                :loading="isReadingFile"
                :disabled="isNavigating || isReadingFile"
                @click="chooseGraphFile"
              />
            </div>

            <div
              aria-live="polite"
              aria-atomic="true"
            >
              <p
                v-if="fileError"
                data-testid="graph-file-error"
                class="mt-3 flex items-start gap-2 text-sm text-error"
              >
                <UIcon
                  name="i-lucide-circle-alert"
                  class="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <span class="min-w-0 break-words">{{ fileError }}</span>
              </p>
            </div>

            <input
              ref="fileInput"
              type="file"
              accept=".json,application/json"
              class="sr-only"
              tabindex="-1"
              aria-hidden="true"
              data-testid="graph-file-input"
              @change="handleFileChosen"
            >
          </section>
        </div>
      </UCard>
    </div>

    <!-- The drop state for the whole page. It takes no pointer events, so the
         drag keeps reaching the page beneath it, where the drop is handled. -->
    <div
      v-if="isDraggingFile"
      class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-default/80 p-6 backdrop-blur-sm"
      aria-hidden="true"
    >
      <div class="max-w-sm rounded-xl border-2 border-dashed border-primary bg-default px-8 py-6 text-center">
        <UIcon
          name="i-lucide-file-json"
          class="size-8 text-primary"
        />
        <p class="mt-2 text-base font-medium text-highlighted">
          Drop to open the graph file
        </p>
        <p class="mt-1 text-sm text-muted">
          It is read in this browser and never uploaded.
        </p>
      </div>
    </div>
  </UContainer>
</template>
