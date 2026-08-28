<script setup lang="ts">
/**
 * Reports a demo that would not start, wherever it was started from.
 *
 * Mounted once for the whole app: the demo can be asked for from a docs
 * preview or from `/view`, and what went wrong is the same either way — so is
 * the only thing that can explain it, which is what the application itself
 * printed before it stopped.
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

/** The tail of the application's own console, which is where the reason is. */
const consoleOutput = computed(() => demo.logLines.slice(-30).join('\n'))

/**
 * Starts the application again from nothing.
 *
 * The startup is all this dialog can offer: it is mounted for the whole app,
 * and why the demo was asked for belongs to whoever asked. A docs preview
 * wanted the graph, which this loads; `/view` wanted the viewer, and takes the
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
    :ui="{ content: 'max-w-2xl' }"
  >
    <template #body>
      <div class="space-y-3">
        <p class="text-sm text-muted">
          The demo is this repository's NestJS application, running in your
          browser on
          <NuxtLink
            to="https://github.com/ScelarOrg/Nodepod"
            target="_blank"
            class="text-primary font-medium"
          >
            nodepod
          </NuxtLink>. Everything it printed before it stopped is below.
        </p>

        <pre
          v-if="consoleOutput"
          data-testid="demo-error-console"
          class="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-3 text-xs text-muted"
        >{{ consoleOutput }}</pre>
        <p
          v-else
          class="text-sm text-muted"
        >
          The application printed nothing, so it did not get as far as starting.
        </p>
      </div>
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
