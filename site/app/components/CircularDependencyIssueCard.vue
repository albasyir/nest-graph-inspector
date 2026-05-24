<script setup lang="ts">
import type { CircularDependencyIssue } from '~/utils/circular-dependency-issues'
import { circularDependencyCategoryLabel } from '~/utils/circular-dependency-issues'

const props = withDefaults(
  defineProps<{
    issue: CircularDependencyIssue
    showId?: boolean
    showCategory?: boolean
  }>(),
  {
    showId: true,
    showCategory: true
  }
)

function cycleTypeLabel(type: CircularDependencyIssue['type']) {
  return type === 'direct' ? 'Direct' : 'Indirect'
}

function cycleTypeColor(type: CircularDependencyIssue['type']) {
  return type === 'direct' ? 'warning' : 'neutral'
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center gap-2">
        <UBadge
          v-if="props.showId"
          :label="`#${props.issue.id}`"
          variant="soft"
        />
        <UBadge
          v-if="props.showCategory"
          :label="circularDependencyCategoryLabel[props.issue.category]"
          color="neutral"
          variant="soft"
        />
        <UBadge
          :label="cycleTypeLabel(props.issue.type)"
          :color="cycleTypeColor(props.issue.type)"
          variant="soft"
        />
      </div>
    </template>

    <div class="space-y-2">
      <p class="font-medium">
        {{ props.issue.from }} -> {{ props.issue.to }}
      </p>
      <p class="font-mono text-xs text-muted break-all">
        {{ props.issue.path.join(' -> ') }}
      </p>
    </div>
  </UCard>
</template>
