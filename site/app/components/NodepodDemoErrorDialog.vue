<script setup lang="ts">
/**
 * Reports a demo that would not start, wherever it was started from.
 *
 * Mounted once for the whole app: the demo can be asked for from a preview on
 * the landing page or from `/view`, and what went wrong is the same either way.
 * It says so in the store's own words; what the application printed is never
 * put on screen.
 */
const demo = useNodepodDemoStore()

const isOpen = computed({
  get: () => demo.status === 'error',
  set: (open: boolean) => {
    if (!open) {
      demo.dismissError()
    }
  }
})

/**
 * Starts the application again from nothing.
 *
 * The startup is all this dialog can offer: it is mounted for the whole app,
 * and why the demo was asked for belongs to whoever asked. A preview wanted
 * the graph, which this loads; `/view` wanted the viewer, and takes the
 * application from running to opened itself.
 */
function retry() {
  demo.stop()
  void demo.loadGraphOutput()
}
</script>

<template>
  <UModal
    v-model:open="isOpen"
    title="The demo application could not start"
    :description="demo.errorMessage || 'The demo application stopped before it reported a graph endpoint.'"
  >
    <template #body>
      <p class="text-sm text-muted">
        The demo is this repository's NestJS application, running in your
        browser on
        <NuxtLink
          to="https://github.com/ScelarOrg/Nodepod"
          target="_blank"
          class="text-primary font-medium"
        >
          nodepod
        </NuxtLink>. Try again to start it from the beginning.
      </p>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          label="Close"
          color="neutral"
          variant="outline"
          class="cursor-pointer"
          @click="isOpen = false"
        />
        <UButton
          label="Try again"
          icon="i-lucide-refresh-cw"
          class="cursor-pointer"
          @click="retry"
        />
      </div>
    </template>
  </UModal>
</template>
