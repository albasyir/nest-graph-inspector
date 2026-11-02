<script setup lang="ts">
import type { GraphOutput } from 'nest-graph-inspector'
import { describePreviewDirectRun } from '~/utils/demo-graph-preview'

const {
  demo,
  view,
  graph,
  staticGraphError,
  statusLabel,
  loadExample,
  retryExample,
  reloadStaticGraph
} = useNodepodDemoGraph()

/**
 * The section is about one provider, so the preview keeps that provider and
 * drops the rest of the graph. Until the visitor loads the example it is the
 * static graph, and nothing runs; once the demo is up, what runs is the real
 * application: the dialog calls its direct-run endpoint and the method executes.
 */
const previewData = computed<GraphOutput | null>(() => {
  const userModule = graph.value?.modules.UserModule
  const userService = userModule?.providers.find(
    provider => provider.name === 'UserService'
  )

  if (!graph.value || !userModule || !userService) {
    return null
  }

  return {
    ...graph.value,
    root: 'UserModule',
    modules: {
      UserModule: {
        ...userModule,
        imports: [],
        exports: ['UserService'],
        providers: [
          {
            ...userService,
            dependencies: []
          }
        ],
        controllers: []
      }
    },
    cycles: {
      modules: [],
      providers: [],
      controllers: []
    }
  }
})

const directRunDisabledReason = computed(() => describePreviewDirectRun(view.value.liveDemo))

function openTrace() {
  navigateTo('/view?preview=true&trace=true')
}
</script>

<template>
  <div class="space-y-3">
    <div class="overflow-hidden rounded-xl border border-default bg-default shadow-sm">
      <ClientOnly>
        <GraphViewer
          v-if="previewData"
          :key="view.source ?? undefined"
          :data="previewData"
          flow-id="runtime-graph-preview-direct-run"
          height="clamp(18rem, 58vh, 34rem)"
          :direct-run-url="view.source === 'live' ? demo.directRunUrl : undefined"
          :direct-run-headers="view.source === 'live' ? demo.requestHeaders : undefined"
          :direct-run-disabled-reason="directRunDisabledReason"
          :show-controls="false"
          :show-mini-map="false"
          :show-circular-dependencies="false"
          :enable-bright-line="false"
          :can-focus-module="false"
          default-open-module-detail
          @trace-open="openTrace"
        />
        <div
          v-else
          class="relative"
        >
          <USkeleton
            class="h-80 w-full rounded-none"
            :class="{ 'animate-none': view.placeholder === 'error' }"
          />
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
            <div
              v-if="view.placeholder === 'error'"
              role="alert"
              class="flex max-w-sm flex-col items-center gap-3"
            >
              <UIcon
                name="i-lucide-circle-alert"
                class="size-6 text-error"
                aria-hidden="true"
              />
              <p class="text-sm text-highlighted">
                The example graph could not be loaded.
              </p>
              <p
                v-if="staticGraphError"
                class="text-sm text-muted text-pretty"
              >
                {{ staticGraphError }}
              </p>
              <div class="flex flex-wrap items-center justify-center gap-2">
                <UButton
                  icon="i-lucide-refresh-cw"
                  label="Try Again"
                  color="neutral"
                  variant="subtle"
                  class="cursor-pointer"
                  @click="reloadStaticGraph"
                />
                <UButton
                  icon="i-lucide-play"
                  label="Load Example"
                  color="neutral"
                  variant="outline"
                  class="cursor-pointer"
                  @click="loadExample"
                />
              </div>
            </div>
            <div
              v-else
              role="status"
              aria-live="polite"
              class="flex flex-col items-center gap-3"
            >
              <UIcon
                name="i-lucide-loader-2"
                class="size-6 animate-spin text-primary"
                aria-hidden="true"
              />
              <p class="text-sm text-muted tabular-nums">
                {{ view.liveDemo === 'starting' ? statusLabel : 'Loading the example graph…' }}
              </p>
            </div>
          </div>
        </div>

        <template #fallback>
          <USkeleton class="h-80 w-full rounded-none" />
        </template>
      </ClientOnly>
    </div>

    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <p class="min-w-0 flex-1 basis-64 text-sm text-muted">
        <template v-if="view.source === 'live'">
          Select the <span class="font-medium text-highlighted">UserService</span> provider and run a
          method: the call reaches the application running in this tab.
        </template>
        <template v-else>
          Select the <span class="font-medium text-highlighted">UserService</span> provider to see its
          methods. Load Example starts the demo application in this tab, so a method you run really
          executes.
        </template>
      </p>

      <ClientOnly>
        <UButton
          v-if="view.liveDemo === 'off'"
          icon="i-lucide-play"
          label="Load Example"
          size="sm"
          color="neutral"
          variant="outline"
          class="shrink-0 cursor-pointer"
          @click="loadExample"
        />
        <p
          v-else-if="view.liveDemo === 'starting'"
          role="status"
          aria-live="polite"
          class="flex shrink-0 items-center gap-2 text-sm text-muted tabular-nums"
        >
          <UIcon
            name="i-lucide-loader-2"
            class="size-4 animate-spin text-primary"
            aria-hidden="true"
          />
          {{ statusLabel }}
        </p>
        <div
          v-else-if="view.liveDemo === 'failed'"
          role="alert"
          class="flex shrink-0 flex-wrap items-center gap-2 text-sm"
        >
          <span class="text-error">The example could not start.</span>
          <UButton
            icon="i-lucide-refresh-cw"
            label="Try Again"
            size="sm"
            color="neutral"
            variant="outline"
            class="cursor-pointer"
            @click="retryExample"
          />
        </div>
      </ClientOnly>
    </div>
  </div>
</template>
