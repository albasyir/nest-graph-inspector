<script setup lang="ts">
import type { GraphOutput } from 'nest-graph-inspector'

const { demo, graph, isIdle, statusLabel, start } = useNodepodDemoGraph()

/**
 * The section is about one provider, so the preview keeps that provider and
 * drops the rest of the graph. What runs is still the real application: the
 * dialog calls its direct-run endpoint and the method executes.
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

function openExecutionSequence() {
  navigateTo('/view?preview=true&execution-sequence=true')
}
</script>

<template>
  <div class="space-y-3">
    <div class="overflow-hidden rounded-xl border border-default bg-default shadow-sm">
      <ClientOnly>
        <GraphViewer
          v-if="previewData"
          :data="previewData"
          flow-id="runtime-graph-preview-direct-run"
          height="clamp(18rem, 58vh, 34rem)"
          :direct-run-url="demo.directRunUrl"
          :direct-run-headers="demo.requestHeaders"
          :show-controls="false"
          :show-mini-map="false"
          :show-circular-dependencies="false"
          :enable-bright-line="false"
          default-open-module-detail
          @execution-sequence-open="openExecutionSequence"
        />
        <div
          v-else
          class="relative"
        >
          <USkeleton class="h-80 w-full rounded-none" />
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center">
            <template v-if="isIdle">
              <UButton
                icon="i-lucide-play"
                label="Run the demo application"
                color="neutral"
                variant="subtle"
                class="cursor-pointer"
                @click="start"
              />
              <p class="max-w-sm text-sm text-muted">
                Starts this repository's NestJS application in your browser, so
                Direct Run has something real to call.
              </p>
            </template>
            <p
              v-else
              class="text-sm text-muted"
            >
              {{ statusLabel }}
            </p>
          </div>
        </div>

        <template #fallback>
          <USkeleton class="h-80 w-full rounded-none" />
        </template>
      </ClientOnly>
    </div>

    <p class="text-sm text-muted">
      Select the <span class="font-medium text-highlighted">UserService</span> provider and run a
      method: the call reaches the application running in this tab.
    </p>
  </div>
</template>
