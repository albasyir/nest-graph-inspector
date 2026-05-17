<script setup lang="ts">
import { storeToRefs } from 'pinia'

const graphStore = useGraphInspectorStore()
const { shouldShowUpdateModal } = storeToRefs(graphStore)
</script>

<template>
  <UModal
    v-model:open="shouldShowUpdateModal"
    title="Update Nest Graph Inspector"
    description="This endpoint is using an older HTTP output format."
  >
    <template #body>
      <p class="text-sm text-muted">
        Please update <code>nest-graph-inspector</code> to at least <code>0.3.0</code> to use the web viewer and AI chat
      </p>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          label="Close"
          color="neutral"
          variant="outline"
          @click="shouldShowUpdateModal = false"
        />
        <UButton
          label="Installation guide"
          icon="i-lucide-book-open"
          to="/getting-started/installation"
          @click="shouldShowUpdateModal = false"
        />
      </div>
    </template>
  </UModal>
</template>
