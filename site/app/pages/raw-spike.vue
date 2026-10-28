<script setup lang="ts">
import type { Nodepod } from '@scelar/nodepod'
import {
  RAW_SPIKE_ENTRY,
  RAW_SPIKE_FILES,
  RAW_SPIKE_PACKAGES,
  RAW_SPIKE_PORT,
  RAW_SPIKE_READY_LINE,
  RAW_SPIKE_REQUEST_PATH,
  RAW_SPIKE_WORKDIR,
  isRawSpikeHelloBody
} from '~/utils/raw-nestjs-spike'

useSeoMeta({
  title: 'Raw NestJS spike',
  description: 'A hand-written, multi-file NestJS application installed from npm and booted inside your browser tab on nodepod.',
  robots: 'noindex'
})

type StepId = 'boot' | 'write' | 'install' | 'bootstrap' | 'ready'
type StepState = 'pending' | 'active' | 'done' | 'failed'
type MemoryStats = ReturnType<Nodepod['memoryStats']>

type RequestResult = {
  status: number
  latencyMs: number
  body: string
  formatted: string
  matchesContract: boolean
  at: Date
}

const STARTUP_TIMEOUT_MS = 120_000
const MAX_LOG_LINES = 2_000
const MEMORY_POLL_MS = 2_000

const STEP_LABELS: Record<StepId, { label: string, detail: string }> = {
  boot: { label: 'Container boot', detail: 'Headless runtime on Web Workers' },
  write: { label: 'VFS write', detail: `${Object.keys(RAW_SPIKE_FILES).length} files into ${RAW_SPIKE_WORKDIR}` },
  install: { label: 'Package install', detail: `${RAW_SPIKE_PACKAGES.length} packages from the npm registry` },
  bootstrap: { label: 'Bootstrap', detail: `node ${RAW_SPIKE_ENTRY}` },
  ready: { label: 'Ready', detail: `Listening on port ${RAW_SPIKE_PORT}` }
}
const STEP_ORDER = Object.keys(STEP_LABELS) as StepId[]

const steps = reactive(
  Object.fromEntries(
    STEP_ORDER.map(id => [id, { state: 'pending' as StepState, ms: null as number | null }])
  ) as Record<StepId, { state: StepState, ms: number | null }>
)
const installingPackage = ref<string | null>(null)
const failure = ref<string | null>(null)
const running = ref(false)
const ready = computed(() => steps.ready.state === 'done')
const runStartedAt = ref<number | null>(null)
const totalMs = ref<number | null>(null)

const logLines = ref<{ id: number, text: string, stream: 'out' | 'err' | 'sys' }[]>([])
let nextLogId = 0
const consoleEl = useTemplateRef<HTMLElement>('consoleEl')
const followConsole = ref(true)

const requesting = ref(false)
const lastResult = ref<RequestResult | null>(null)
const latencies = ref<number[]>([])

const memory = shallowRef<MemoryStats | null>(null)
const installedCount = ref<number | null>(null)

let pod: Nodepod | undefined
let disposed = false
let memoryTimer: ReturnType<typeof setInterval> | undefined

// Nest's logger colours its output; the console renders text, not a terminal.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1B\[[0-9;]*[A-Za-z]/g

function appendLog(chunk: string, stream: 'out' | 'err' | 'sys' = 'out') {
  const lines = chunk.replace(ANSI_PATTERN, '').split(/\r?\n/)

  for (const text of lines) {
    if (text.trim()) {
      logLines.value.push({ id: nextLogId++, text, stream })
    }
  }

  if (logLines.value.length > MAX_LOG_LINES) {
    logLines.value.splice(0, logLines.value.length - MAX_LOG_LINES)
  }

  if (followConsole.value) {
    nextTick(() => {
      consoleEl.value?.scrollTo({ top: consoleEl.value.scrollHeight })
    })
  }
}

function onConsoleScroll() {
  const el = consoleEl.value

  if (el) {
    followConsole.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
}

/** Runs one step, recording its duration and marking it failed if it throws. */
async function step<T>(id: StepId, work: () => Promise<T>): Promise<T> {
  steps[id].state = 'active'
  const startedAt = performance.now()

  try {
    const result = await work()
    steps[id].ms = performance.now() - startedAt
    steps[id].state = 'done'

    return result
  } catch (error) {
    steps[id].ms = performance.now() - startedAt
    steps[id].state = 'failed'
    throw error
  }
}

function sampleMemory() {
  if (pod) {
    memory.value = pod.memoryStats()
  }
}

function resetRun() {
  for (const id of STEP_ORDER) {
    steps[id].state = 'pending'
    steps[id].ms = null
  }

  failure.value = null
  totalMs.value = null
  lastResult.value = null
  latencies.value = []
  memory.value = null
  installedCount.value = null
  logLines.value = []
  followConsole.value = true
}

function stopPod() {
  clearInterval(memoryTimer)
  memoryTimer = undefined
  pod?.teardown()
  pod = undefined
}

async function runSpike() {
  stopPod()
  resetRun()
  running.value = true
  runStartedAt.value = performance.now()

  try {
    const booted = await step('boot', async () => {
      const { Nodepod: NodepodRuntime } = await import('@scelar/nodepod')

      // Headless keeps the runtime off the Service Worker, which cannot be
      // granted the origin-root scope it wants on GitHub Pages. Nothing is
      // cached, so private browsing modes that refuse IndexedDB still work.
      return NodepodRuntime.boot({
        workdir: RAW_SPIKE_WORKDIR,
        headless: true,
        enableSnapshotCache: false,
        packageStore: 'memory'
      })
    })

    if (disposed) {
      booted.teardown()

      return
    }

    pod = booted
    appendLog(`Container booted, workdir ${RAW_SPIKE_WORKDIR}`, 'sys')

    await step('write', async () => {
      for (const [path, content] of Object.entries(RAW_SPIKE_FILES)) {
        await booted.fs.writeFile(path, content)
        appendLog(`wrote ${path} (${content.length} B)`, 'sys')
      }
    })

    await step('install', async () => {
      for (const [name, version] of RAW_SPIKE_PACKAGES) {
        installingPackage.value = `${name}@${version}`
        appendLog(`installing ${name}@${version}`, 'sys')
        await booted.packages.install(name, version, {
          onProgress: message => appendLog(message, 'sys')
        })
      }

      installingPackage.value = null
      installedCount.value = Object.keys(booted.packages.listInstalled()).length
    })

    if (disposed) {
      return
    }

    memoryTimer = setInterval(sampleMemory, MEMORY_POLL_MS)
    sampleMemory()

    await step('bootstrap', async () => {
      const app = await booted.spawn('node', [RAW_SPIKE_ENTRY], { cwd: RAW_SPIKE_WORKDIR })
      let exitCode: number | undefined
      let log = ''

      const onChunk = (stream: 'out' | 'err') => (chunk: string) => {
        log += chunk
        appendLog(chunk, stream)
      }

      app.on('output', onChunk('out'))
      app.on('error', onChunk('err'))
      app.on('exit', (code: number) => {
        exitCode = code
        appendLog(`process exited with code ${code}`, 'sys')
      })

      const startedAt = performance.now()

      while (!log.includes(RAW_SPIKE_READY_LINE)) {
        if (disposed) {
          return
        }

        if (exitCode !== undefined) {
          throw new Error(`The application exited with code ${exitCode} before it was ready.`)
        }

        if (performance.now() - startedAt > STARTUP_TIMEOUT_MS) {
          throw new Error(`The application was not ready within ${STARTUP_TIMEOUT_MS / 1000} s.`)
        }

        await new Promise(resolve => setTimeout(resolve, 50))
      }
    })

    steps.ready.state = 'done'
    steps.ready.ms = 0
    totalMs.value = performance.now() - (runStartedAt.value ?? 0)
    sampleMemory()
  } catch (error) {
    failure.value = error instanceof Error ? error.message : String(error)
    appendLog(failure.value, 'err')
    installingPackage.value = null
  } finally {
    running.value = false
  }
}

async function sendRequest() {
  if (!pod || !ready.value || requesting.value) {
    return
  }

  requesting.value = true

  try {
    const startedAt = performance.now()
    const response = await pod.request(RAW_SPIKE_PORT, { path: RAW_SPIKE_REQUEST_PATH })
    const latencyMs = performance.now() - startedAt
    const body = new TextDecoder().decode(response.body ?? new Uint8Array())
    let formatted = body
    let matchesContract = false

    try {
      const parsed: unknown = JSON.parse(body)
      formatted = JSON.stringify(parsed, null, 2)
      matchesContract = response.statusCode === 200 && isRawSpikeHelloBody(parsed)
    } catch {
      // Not JSON: shown as it came back, and it does not match the contract.
    }

    lastResult.value = { status: response.statusCode, latencyMs, body, formatted, matchesContract, at: new Date() }
    latencies.value = [...latencies.value.slice(-49), latencyMs]
    appendLog(`GET ${RAW_SPIKE_REQUEST_PATH} → ${response.statusCode} in ${latencyMs.toFixed(1)} ms`, 'sys')
    sampleMemory()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendLog(`GET ${RAW_SPIKE_REQUEST_PATH} failed: ${message}`, 'err')
  } finally {
    requesting.value = false
  }
}

onMounted(() => {
  runSpike()
})

onBeforeUnmount(() => {
  disposed = true
  stopPod()
})

const formatMs = (value: number | null) =>
  value === null ? '—' : value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(0)} ms`
const formatMb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const latencyStats = computed(() => {
  const values = latencies.value

  if (!values.length) {
    return null
  }

  const sorted = [...values].sort((a, b) => a - b)

  return {
    count: values.length,
    min: sorted[0]!,
    median: sorted[Math.floor(sorted.length / 2)]!,
    max: sorted[sorted.length - 1]!
  }
})

const statusLabel = computed(() => {
  if (failure.value) {
    return 'Failed'
  }

  if (ready.value) {
    return 'Running'
  }

  return running.value ? 'Starting' : 'Stopped'
})

const statusColor = computed(() => {
  if (failure.value) {
    return 'error' as const
  }

  return ready.value ? 'success' as const : 'neutral' as const
})

const memoryRows = computed(() => {
  const stats = memory.value

  if (!stats) {
    return []
  }

  return [
    { label: 'VFS files', value: stats.vfs.fileCount.toLocaleString() },
    { label: 'VFS size', value: formatMb(stats.vfs.totalBytes) },
    { label: 'Installed packages', value: installedCount.value?.toLocaleString() ?? '—' },
    { label: 'Module cache', value: stats.engine.moduleCacheSize.toLocaleString() },
    { label: 'Processes', value: stats.runtime.processes.toLocaleString() },
    { label: 'Workers', value: stats.runtime.workers.toLocaleString() },
    { label: 'Heap used', value: stats.heap ? `${stats.heap.usedMB.toFixed(1)} / ${stats.heap.limitMB.toFixed(0)} MB` : 'Not reported' }
  ]
})

const STEP_ICONS: Record<StepState, string> = {
  pending: 'i-lucide-circle',
  active: 'i-lucide-loader-circle',
  done: 'i-lucide-circle-check',
  failed: 'i-lucide-circle-x'
}
</script>

<template>
  <UContainer class="py-10 lg:py-14">
    <header class="flex flex-col gap-4 border-b border-default pb-8 md:flex-row md:items-end md:justify-between">
      <div class="max-w-2xl">
        <p class="font-mono text-xs uppercase tracking-wider text-muted">
          Spike · nodepod runtime
        </p>
        <h1 class="mt-2 text-3xl font-semibold tracking-tight text-highlighted text-balance">
          Raw NestJS, installed and booted in this tab
        </h1>
        <p class="mt-3 text-pretty text-muted">
          Four hand-written CommonJS files and five packages fetched from npm, started with
          <code class="font-mono text-sm">node {{ RAW_SPIKE_ENTRY }}</code>. No bundle, no server: every request
          below is answered by Express running on a virtual port inside your browser.
        </p>
      </div>

      <div class="flex items-center gap-3">
        <UBadge
          :color="statusColor"
          variant="subtle"
          size="lg"
          :label="statusLabel"
          role="status"
          aria-live="polite"
        />
        <UButton
          icon="i-lucide-rotate-ccw"
          color="neutral"
          variant="outline"
          :label="running ? 'Starting…' : 'Restart'"
          :disabled="running"
          @click="runSpike"
        />
      </div>
    </header>

    <div class="mt-8 grid gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div class="flex flex-col gap-8">
        <section aria-labelledby="pipeline-heading">
          <div class="flex items-baseline justify-between">
            <h2
              id="pipeline-heading"
              class="text-sm font-semibold text-highlighted"
            >
              Pipeline
            </h2>
            <span class="font-mono text-xs tabular-nums text-muted">
              total {{ formatMs(totalMs) }}
            </span>
          </div>

          <ol class="mt-3 divide-y divide-default rounded-lg border border-default">
            <li
              v-for="id in STEP_ORDER"
              :key="id"
              class="flex items-center gap-3 px-4 py-3"
              :aria-current="steps[id].state === 'active' ? 'step' : undefined"
            >
              <UIcon
                :name="STEP_ICONS[steps[id].state]"
                class="size-4 shrink-0"
                :class="{
                  'text-dimmed': steps[id].state === 'pending',
                  'animate-spin text-primary motion-reduce:animate-none': steps[id].state === 'active',
                  'text-success': steps[id].state === 'done',
                  'text-error': steps[id].state === 'failed'
                }"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <p
                  class="text-sm"
                  :class="steps[id].state === 'pending' ? 'text-muted' : 'text-highlighted'"
                >
                  {{ STEP_LABELS[id].label }}
                  <span class="sr-only">— {{ steps[id].state }}</span>
                </p>
                <p class="truncate font-mono text-xs text-muted">
                  {{ id === 'install' && installingPackage ? installingPackage : STEP_LABELS[id].detail }}
                </p>
              </div>
              <span class="font-mono text-xs tabular-nums text-muted">
                {{ id === 'ready' ? '' : formatMs(steps[id].ms) }}
              </span>
            </li>
          </ol>

          <UAlert
            v-if="failure"
            class="mt-4"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="The spike did not start"
            :description="failure"
          />
        </section>

        <section aria-labelledby="memory-heading">
          <h2
            id="memory-heading"
            class="text-sm font-semibold text-highlighted"
          >
            Runtime memory
          </h2>
          <dl
            v-if="memoryRows.length"
            class="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-default bg-[var(--ui-border)]"
          >
            <div
              v-for="row in memoryRows"
              :key="row.label"
              class="bg-default px-4 py-3"
            >
              <dt class="text-xs text-muted">
                {{ row.label }}
              </dt>
              <dd class="mt-1 font-mono text-sm tabular-nums text-highlighted">
                {{ row.value }}
              </dd>
            </div>
          </dl>
          <p
            v-else
            class="mt-3 text-sm text-muted"
          >
            Sampled every {{ MEMORY_POLL_MS / 1000 }} s once packages are installed.
          </p>
        </section>
      </div>

      <div class="flex min-w-0 flex-col gap-8">
        <section aria-labelledby="request-heading">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2
              id="request-heading"
              class="text-sm font-semibold text-highlighted"
            >
              Request
            </h2>
            <UButton
              icon="i-lucide-send"
              :loading="requesting"
              :disabled="!ready"
              @click="sendRequest"
            >
              <span class="font-mono">GET {{ RAW_SPIKE_REQUEST_PATH }}</span>
            </UButton>
          </div>

          <div class="mt-3 rounded-lg border border-default">
            <div
              class="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-default px-4 py-3 text-sm"
              aria-live="polite"
            >
              <template v-if="lastResult">
                <span class="flex items-center gap-2">
                  <span class="text-muted">Status</span>
                  <span
                    class="font-mono tabular-nums"
                    :class="lastResult.status === 200 ? 'text-success' : 'text-error'"
                  >{{ lastResult.status }}</span>
                </span>
                <span class="flex items-center gap-2">
                  <span class="text-muted">Latency</span>
                  <span class="font-mono tabular-nums text-highlighted">{{ lastResult.latencyMs.toFixed(1) }} ms</span>
                </span>
                <span class="flex items-center gap-2">
                  <span class="text-muted">Contract</span>
                  <span :class="lastResult.matchesContract ? 'text-success' : 'text-error'">
                    {{ lastResult.matchesContract ? '{ message, success: true }' : 'Unexpected body' }}
                  </span>
                </span>
              </template>
              <span
                v-else
                class="text-muted"
              >
                {{ ready ? 'Send a request to the live server.' : 'Available once the application is ready.' }}
              </span>
            </div>

            <pre
              class="max-h-64 overflow-auto px-4 py-3 font-mono text-xs leading-relaxed text-default"
              aria-label="Response body"
            >{{ lastResult ? lastResult.formatted : '—' }}</pre>
          </div>

          <dl
            v-if="latencyStats"
            class="mt-3 flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs tabular-nums text-muted"
          >
            <div class="flex gap-1.5">
              <dt>requests</dt><dd class="text-highlighted">
                {{ latencyStats.count }}
              </dd>
            </div>
            <div class="flex gap-1.5">
              <dt>min</dt><dd class="text-highlighted">
                {{ latencyStats.min.toFixed(1) }} ms
              </dd>
            </div>
            <div class="flex gap-1.5">
              <dt>median</dt><dd class="text-highlighted">
                {{ latencyStats.median.toFixed(1) }} ms
              </dd>
            </div>
            <div class="flex gap-1.5">
              <dt>max</dt><dd class="text-highlighted">
                {{ latencyStats.max.toFixed(1) }} ms
              </dd>
            </div>
          </dl>
        </section>

        <section
          aria-labelledby="console-heading"
          class="flex min-h-0 flex-col"
        >
          <div class="flex items-baseline justify-between">
            <h2
              id="console-heading"
              class="text-sm font-semibold text-highlighted"
            >
              Console
            </h2>
            <span class="font-mono text-xs tabular-nums text-muted">
              {{ logLines.length }} lines<template v-if="!followConsole"> · paused</template>
            </span>
          </div>
          <div
            ref="consoleEl"
            class="mt-3 h-96 overflow-auto rounded-lg border border-default bg-elevated/50 px-4 py-3 font-mono text-xs leading-relaxed"
            role="log"
            aria-labelledby="console-heading"
            tabindex="0"
            @scroll.passive="onConsoleScroll"
          >
            <p
              v-for="line in logLines"
              :key="line.id"
              class="whitespace-pre-wrap break-words"
              :class="{
                'text-default': line.stream === 'out',
                'text-error': line.stream === 'err',
                'text-muted': line.stream === 'sys'
              }"
              v-text="line.text"
            />
            <p
              v-if="!logLines.length"
              class="text-muted"
            >
              Waiting for output…
            </p>
          </div>
        </section>
      </div>
    </div>
  </UContainer>
</template>
