<script setup lang="ts">
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
  interactive?: BooleanProp
  /** Offer "Load Example", which starts the demo itself and draws it live. */
  showLoadExample?: BooleanProp
  showControls?: BooleanProp
  showMiniMap?: BooleanProp
}>(), {
  previewId: undefined,
  fixBightline: false,
  height: 'clamp(14rem, 52vh, 28rem)',
  excludeModules: () => [],
  showCircularDependencies: true,
  showBrightLine: true,
  collapsedModules: () => [],
  caption: undefined,
  interactive: true,
  showLoadExample: false,
  showControls: false,
  showMiniMap: false
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

const isInteractive = computed(() => parseBooleanProp(props.interactive, true))
const shouldShowLoadExample = computed(() => parseBooleanProp(props.showLoadExample, false))
const shouldShowControls = computed(() => parseBooleanProp(props.showControls, false))
const shouldShowMiniMap = computed(() => parseBooleanProp(props.showMiniMap, false))

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

const {
  view,
  graph,
  staticGraphError,
  statusLabel,
  loadExample,
  retryExample,
  reloadStaticGraph
} = useNodepodDemoGraph()

/** Which graph this is, said after the caption. */
const sourceSentence = computed(() =>
  view.value.source === 'live'
    ? 'Live graph of the demo application running in your browser.'
    : 'Static graph of the demo project, exported with'
)
</script>

<template>
  <div class="space-y-3">
    <ClientOnly>
      <GraphViewer
        v-if="graph"
        :key="view.source ?? undefined"
        :data="graph"
        :flow-id="viewerFlowId"
        :height="props.height"
        :interactive="isInteractive"
        :show-controls="shouldShowControls"
        :show-mini-map="shouldShowMiniMap"
        :fix-bightline="props.fixBightline"
        :exclude-modules="props.excludeModules"
        :collapsed-modules="props.collapsedModules"
        :show-circular-dependencies="shouldShowCircularDependencies"
        :enable-bright-line="shouldShowBrightLine"
        default-open-module-detail
      />
      <div
        v-else
        class="relative"
      >
        <USkeleton
          class="runtime-graph-preview__skeleton w-full rounded-xl"
          :class="{ 'animate-none': view.placeholder === 'error' }"
          :style="{ height: props.height }"
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
        <USkeleton
          class="runtime-graph-preview__skeleton w-full rounded-xl"
          :style="{ height: props.height }"
        />
      </template>
    </ClientOnly>

    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <p class="min-w-0 flex-1 basis-64 text-sm text-muted">
        <template v-if="fixedBrightLineLabel">
          This example shows what happens when you hover
          <span class="font-medium text-highlighted">{{ fixedBrightLineLabel }}</span>.
        </template>
        <template v-else-if="previewCaption">
          {{ previewCaption }}
        </template>
        {{ sourceSentence }}
        <template v-if="view.source !== 'live'">
          <code class="text-xs">nest-graph-inspector export</code>.
        </template>
        <NuxtLink
          to="/view?preview=true"
          class="text-primary font-medium"
        >
          Open full-screen demo
        </NuxtLink>
      </p>

      <ClientOnly v-if="shouldShowLoadExample">
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
