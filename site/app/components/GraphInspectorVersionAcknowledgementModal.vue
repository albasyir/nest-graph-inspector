<script setup lang="ts">
import { storeToRefs } from 'pinia'

const graphStore = useGraphInspectorStore()
const {
  endpointVersion,
  latestVersion,
  shouldShowVersionAcknowledgement
} = storeToRefs(graphStore)
</script>

<template>
  <UModal
    v-model:open="shouldShowVersionAcknowledgement"
    :close="false"
    :dismissible="false"
    title="Update available"
    description="This graph does not confirm that it was generated with the latest nest-graph-inspector version."
  >
    <template #body>
      <div class="space-y-3 text-sm text-muted">
        <p>
          Your version: <code>{{ endpointVersion ?? 'Unavailable' }}</code>
        </p>
        <p>
          Latest version: <code>{{ latestVersion ?? 'Unavailable' }}</code>
        </p>
        <p>Acknowledge this difference before viewing the graph.</p>
      </div>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          label="Upgrade guide"
          icon="i-lucide-book-open"
          color="neutral"
          variant="outline"
          to="/getting-started/upgrade-guide"
        />
        <UButton
          label="Continue"
          @click="graphStore.acknowledgeEndpointVersion()"
        />
      </div>
    </template>
  </UModal>
</template>
