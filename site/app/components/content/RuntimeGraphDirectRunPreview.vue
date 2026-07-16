<script setup lang="ts">
import type { GraphOutput } from 'nest-graph-inspector'

const config = useRuntimeConfig()
let base = config.app.baseURL || '/'
if (!base.endsWith('/')) {
  base += '/'
}

const { data, status, error } = await useLazyAsyncData(
  'runtime-graph-direct-run-preview',
  () => $fetch<GraphOutput>(`${base}mock-graph/output.json`),
  { server: false }
)

const previewData = computed<GraphOutput | null>(() => {
  const userModule = data.value?.modules.UserModule
  const userService = userModule?.providers.find(provider => provider.name === 'UserService')

  if (!data.value || !userModule || !userService) {
    return null
  }

  return {
    ...data.value,
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

const directRunUrl = computed(() => `${base}mock-graph/direct-run`)

function openExecutionSequence() {
  navigateTo('/view?preview=true&execution-sequence=true')
}
</script>

<template>
  <div class="space-y-3">
    <div class="overflow-hidden rounded-xl border border-default bg-default shadow-sm">
      <ClientOnly>
        <GraphViewer
          v-if="status === 'success' && previewData"
          :data="previewData"
          flow-id="runtime-graph-preview-direct-run"
          height="clamp(18rem, 58vh, 34rem)"
          :direct-run-url="directRunUrl"
          :direct-run-disabled="true"
          :show-controls="false"
          :show-mini-map="false"
          :show-circular-dependencies="false"
          :enable-bright-line="false"
          default-open-module-detail
          @execution-sequence-open="openExecutionSequence"
        />
        <UAlert
          v-else-if="status === 'error'"
          icon="i-lucide-triangle-alert"
          color="error"
          variant="subtle"
          title="Could not load preview graph"
          :description="error?.message || 'The mock graph endpoint is unavailable.'"
        />
        <USkeleton
          v-else
          class="h-80 w-full rounded-none"
        />

        <template #fallback>
          <USkeleton class="h-80 w-full rounded-none" />
        </template>
      </ClientOnly>
    </div>

    <p class="text-sm text-muted">
      Select the <span class="font-medium text-highlighted">UserService</span> provider to see the static graph Direct Run dialog.
    </p>
  </div>
</template>
