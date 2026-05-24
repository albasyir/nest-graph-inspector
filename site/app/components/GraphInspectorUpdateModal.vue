<script setup lang="ts">
import { storeToRefs } from 'pinia'

const graphStore = useGraphInspectorStore()
const { shouldShowUpdateModal } = storeToRefs(graphStore)
</script>

<template>
  <UModal
    v-model:open="shouldShowUpdateModal"
    title="Update Nest Graph Inspector"
    description="This endpoint is using an unsupported graph output version."
  >
    <template #body>
      <div class="space-y-3">
        <p class="text-sm text-muted">
          Your app is using an older graph output format. Update <code>nest-graph-inspector</code> and restart your app.
        </p>
        <ContentPackageManagerCommand command="update" />
      </div>
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
          label="Upgrade guide"
          icon="i-lucide-book-open"
          color="primary"
          variant="solid"
          to="/getting-started/upgrade-guide"
          @click="shouldShowUpdateModal = false"
        />
      </div>
    </template>
  </UModal>
</template>
