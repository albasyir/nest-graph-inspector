<script setup lang="ts">
import type { GraphOutput } from '@library/libs/nest-graph-inspector/src/types/graph-output.type'

type BooleanProp = boolean | string
type ModuleListProp = string[] | string

const props = withDefaults(defineProps<{
  previewId?: string
  fixBightline?: boolean | string
  height?: string
  excludeModules?: ModuleListProp
  showCircularDependencies?: BooleanProp
  showBrightLine?: BooleanProp
  collapsedModules?: ModuleListProp
  caption?: string
}>(), {
  previewId: undefined,
  fixBightline: false,
  height: 'clamp(14rem, 52vh, 28rem)',
  excludeModules: () => [],
  showCircularDependencies: true,
  showBrightLine: true,
  collapsedModules: () => [],
  caption: 'Interactive preview from the built-in mock graph.'
})

function parseBooleanProp(value: BooleanProp | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback
  }

  return value !== false && value !== 'false'
}

const generatedPreviewId = useId()

const previewId = computed(() => {
  const explicitId = props.previewId?.trim()
  return explicitId || generatedPreviewId
})

const viewerFlowId = computed(() => `runtime-graph-preview-${previewId.value}`)

const shouldShowCircularDependencies = computed(() =>
  parseBooleanProp(props.showCircularDependencies, true)
)

const shouldShowBrightLine = computed(() =>
  parseBooleanProp(props.showBrightLine, true)
)

const previewCaption = computed(() => {
  if (fixedBrightLineLabel.value) {
    return null
  }

  return props.caption
})

const fixedBrightLineLabel = computed(() => {
  const fixedTarget = props.fixBightline
  if (fixedTarget === false || fixedTarget === undefined) {
    return null
  }

  if (typeof fixedTarget === 'string') {
    const label = fixedTarget.trim()
    return label || 'UserRepository'
  }

  return 'UserRepository'
})

const config = useRuntimeConfig()
let base = config.app.baseURL || '/'
if (!base.endsWith('/')) {
  base += '/'
}

const { data, status, error } = await useLazyAsyncData(
  `runtime-graph-preview:${previewId.value}`,
  () => $fetch<GraphOutput>(`${base}mock-graph/output.json`),
  { server: false }
)
</script>

<template>
  <div class="space-y-3">
    <ClientOnly>
      <GraphViewer
        v-if="status === 'success' && data"
        :data="data"
        :flow-id="viewerFlowId"
        :height="props.height"
        :interactive="false"
        :fix-bightline="props.fixBightline"
        :exclude-modules="props.excludeModules"
        :collapsed-modules="props.collapsedModules"
        :show-circular-dependencies="shouldShowCircularDependencies"
        :enable-bright-line="shouldShowBrightLine"
        default-open-module-detail
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
        class="runtime-graph-preview__skeleton w-full rounded-xl"
        :style="{ height: props.height }"
      />

      <template #fallback>
        <USkeleton
          class="runtime-graph-preview__skeleton w-full rounded-xl"
          :style="{ height: props.height }"
        />
      </template>
    </ClientOnly>

    <p class="text-sm text-muted">
      <template v-if="fixedBrightLineLabel">
        This example shows what happens when you hover
        <span class="font-medium text-highlighted">{{ fixedBrightLineLabel }}</span>.
      </template>
      <template v-else>
        {{ previewCaption }}
      </template>
      <NuxtLink
        to="/view?preview=true"
        class="text-primary font-medium"
      >
        Open full-screen demo
      </NuxtLink>
    </p>
  </div>
</template>
