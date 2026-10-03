<script setup lang="ts">
import { storeToRefs } from 'pinia'
import type { ArchitectureIssueCategory } from '~/utils/architecture-issues'
import {
  ARCHITECTURE_ISSUE_CATEGORIES,
  architectureIssueCategoryIcon,
  architectureIssueCategoryLabel,
  collectArchitectureIssues,
  summarizeArchitectureIssues
} from '~/utils/architecture-issues'

definePageMeta({
  layout: 'viewer'
})

const graphStore = useGraphInspectorStore()
const {
  graphData,
  errorMessage,
  endpointRequiresAccessToken,
  hasLoadError
} = storeToRefs(graphStore)
const { endpointUrl, isGraphLoading, startupMessage, refresh }
  = useGraphViewerPage()

const issues = computed(() => collectArchitectureIssues(graphData.value))
const summary = computed(() => summarizeArchitectureIssues(issues.value))

const activeCategory = ref<ArchitectureIssueCategory | 'all'>('all')
const visibleIssues = computed(() =>
  activeCategory.value === 'all'
    ? issues.value
    : issues.value.filter(issue => issue.category === activeCategory.value)
)

const summaryPills = computed(() => [
  { label: 'Total Issues', count: summary.value.total, icon: 'i-lucide-list-checks', class: 'border-default' },
  { label: 'Critical / Errors', count: summary.value.errors, icon: 'i-lucide-octagon-alert', class: 'border-error/40 text-error' },
  { label: 'Warnings', count: summary.value.warnings, icon: 'i-lucide-triangle-alert', class: 'border-warning/40 text-warning' },
  { label: 'Cleanups', count: summary.value.cleanups, icon: 'i-lucide-info', class: 'border-info/40 text-info' }
])

const categoryTabs = computed(() => [
  { value: 'all' as const, label: 'All', icon: 'i-lucide-layers', count: summary.value.total },
  ...ARCHITECTURE_ISSUE_CATEGORIES.map(category => ({
    value: category,
    label: architectureIssueCategoryLabel[category],
    icon: architectureIssueCategoryIcon[category],
    count: summary.value.byCategory[category]
  }))
])

const emptyStateDescription = computed(() =>
  activeCategory.value === 'all'
    ? 'No cycles, duplicate providers, unused imports, dead exports, or disconnected modules in the current graph.'
    : `No ${architectureIssueCategoryLabel[activeCategory.value].toLowerCase()} in the current graph.`
)

useSeoMeta({
  title: 'Architecture Health',
  ogTitle: 'Architecture Health - Nest Graph Inspector',
  description: 'Architecture health and diagnostics for the current NestJS graph.'
})
</script>

<template>
  <div class="h-full overflow-y-auto p-4 sm:p-6">
    <GraphViewerLoadingState
      v-if="isGraphLoading"
      :endpoint="endpointUrl"
      :message="startupMessage"
    />

    <GraphViewerErrorState
      v-else-if="hasLoadError"
      :message="errorMessage"
      :requires-access-token="endpointRequiresAccessToken"
      @retry="refresh()"
    />

    <div
      v-else-if="graphData"
      class="mx-auto w-full max-w-5xl space-y-4"
    >
      <div class="space-y-1">
        <h1 class="text-lg font-semibold">
          Architecture Health &amp; Diagnostics
        </h1>
        <p class="text-sm text-muted">
          {{ summary.total }} issue{{ summary.total === 1 ? '' : 's' }} found
          in the module graph of {{ graphData.root }}
        </p>
      </div>

      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div
          v-for="pill in summaryPills"
          :key="pill.label"
          class="flex items-center gap-2.5 rounded-lg border px-3 py-2"
          :class="pill.class"
        >
          <UIcon
            :name="pill.icon"
            class="size-4 shrink-0"
          />
          <span class="text-xs font-medium text-muted">{{ pill.label }}</span>
          <span class="ms-auto text-lg font-semibold tabular-nums">{{ pill.count }}</span>
        </div>
      </div>

      <div
        class="flex flex-wrap gap-1.5"
        role="tablist"
        aria-label="Issue categories"
      >
        <UButton
          v-for="tab in categoryTabs"
          :key="tab.value"
          role="tab"
          :aria-selected="activeCategory === tab.value"
          :icon="tab.icon"
          :label="tab.label"
          size="sm"
          :color="activeCategory === tab.value ? 'primary' : 'neutral'"
          :variant="activeCategory === tab.value ? 'soft' : 'ghost'"
          @click="activeCategory = tab.value"
        >
          <template #trailing>
            <UBadge
              :label="String(tab.count)"
              :color="activeCategory === tab.value ? 'primary' : 'neutral'"
              variant="subtle"
              size="sm"
            />
          </template>
        </UButton>
      </div>

      <UAlert
        v-if="visibleIssues.length === 0"
        icon="i-lucide-circle-check"
        color="success"
        variant="subtle"
        title="Your architecture looks healthy"
        :description="emptyStateDescription"
      />

      <div
        v-else
        class="space-y-3"
      >
        <ArchitectureIssueCard
          v-for="issue in visibleIssues"
          :key="issue.id"
          :issue="issue"
        />
      </div>
    </div>

    <div
      v-else
      class="flex h-full min-h-0 flex-col items-center justify-center gap-4"
    >
      <div
        class="flex size-16 items-center justify-center rounded-2xl bg-primary/10"
      >
        <UIcon
          name="i-lucide-file-json"
          class="size-8 text-primary"
        />
      </div>
      <div class="space-y-2 text-center">
        <p class="text-lg font-medium">
          No data received
        </p>
        <p class="text-sm text-muted">
          The endpoint returned an empty response.
        </p>
        <UButton
          icon="i-lucide-refresh-cw"
          label="Retry"
          variant="outline"
          class="mt-2"
          @click="refresh()"
        />
      </div>
    </div>
  </div>
</template>
