<script setup lang="ts">
import { buildCircularIssueFlow } from '~/utils/circular-dependency-flow'
import type { ArchitectureIssue } from '~/utils/architecture-issues'
import {
  architectureIssueCategoryIcon,
  architectureIssueCategoryLabel,
  architectureIssueSeverityColor,
  architectureIssueSeverityIcon,
  architectureIssueSeverityLabel
} from '~/utils/architecture-issues'

const props = defineProps<{
  issue: ArchitectureIssue
}>()

// Each cycle diagram is its own Vue Flow instance, so it is built on demand.
const isCycleFlowOpen = ref(false)
const cycleFlow = computed(() =>
  props.issue.circularIssue && isCycleFlowOpen.value
    ? buildCircularIssueFlow(props.issue.circularIssue)
    : null
)

const focusLink = computed(() => ({
  path: '/view/navigator',
  query: { 'focus-module': props.issue.module }
}))
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center gap-2">
        <UBadge
          :icon="architectureIssueSeverityIcon[props.issue.severity]"
          :label="architectureIssueSeverityLabel[props.issue.severity]"
          :color="architectureIssueSeverityColor[props.issue.severity]"
          variant="subtle"
        />
        <UBadge
          :icon="architectureIssueCategoryIcon[props.issue.category]"
          :label="architectureIssueCategoryLabel[props.issue.category]"
          color="neutral"
          variant="soft"
        />
        <UBadge
          icon="i-lucide-box"
          :label="props.issue.module"
          color="neutral"
          variant="outline"
        />
        <UButton
          :to="focusLink"
          icon="i-lucide-scan-search"
          label="Focus in Graph"
          size="xs"
          color="neutral"
          variant="ghost"
          class="ms-auto"
        />
      </div>
    </template>

    <div class="space-y-3">
      <div class="space-y-1">
        <p class="font-medium">
          {{ props.issue.title }}
        </p>
        <p class="text-sm text-muted">
          {{ props.issue.description }}
        </p>
      </div>

      <div
        v-if="props.issue.relatedModules?.length"
        class="flex flex-wrap items-center gap-1.5 text-xs text-muted"
      >
        <span>Related:</span>
        <UBadge
          v-for="moduleName in props.issue.relatedModules"
          :key="moduleName"
          :label="moduleName"
          color="neutral"
          variant="soft"
          size="sm"
        />
      </div>

      <div
        v-if="props.issue.circularIssue"
        class="space-y-2"
      >
        <div class="flex flex-wrap items-center gap-1.5 text-xs">
          <template
            v-for="(step, index) in props.issue.circularIssue.path"
            :key="`${index}-${step}`"
          >
            <UIcon
              v-if="index > 0"
              name="i-lucide-arrow-right"
              class="size-3.5 text-warning"
            />
            <span class="rounded-md border border-default px-2 py-0.5 font-medium">
              {{ step }}
            </span>
          </template>
        </div>
        <UButton
          :icon="isCycleFlowOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          :label="isCycleFlowOpen ? 'Hide cycle diagram' : 'Show cycle diagram'"
          size="xs"
          color="neutral"
          variant="link"
          class="px-0"
          @click="isCycleFlowOpen = !isCycleFlowOpen"
        />
        <CircularDependencyIssueCard
          v-if="cycleFlow"
          :issue="props.issue.circularIssue"
          :flow="cycleFlow"
          :flow-id="`architecture-issue-${props.issue.id}`"
        />
      </div>

      <div class="flex gap-2.5 rounded-md border border-primary/25 bg-primary/5 p-3">
        <UIcon
          name="i-lucide-lightbulb"
          class="mt-0.5 size-4 shrink-0 text-primary"
        />
        <div class="space-y-0.5">
          <p class="text-xs font-semibold uppercase tracking-wide text-primary">
            How to fix
          </p>
          <p class="text-sm">
            {{ props.issue.remediation }}
          </p>
        </div>
      </div>
    </div>
  </UCard>
</template>
