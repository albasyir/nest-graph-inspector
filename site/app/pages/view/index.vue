<script setup lang="ts">
useSeoMeta({
  title: 'Graph Viewer',
  ogTitle: 'Graph Viewer - Nest Graph Inspector',
  description: 'View your NestJS dependency graph in real-time by providing the inspector endpoint URL.'
})

const urlInput = ref('')
const errorMessage = ref('')

function onSubmit() {
  if (!urlInput.value.trim()) {
    errorMessage.value = 'Please enter a valid URL'
    return
  }

  try {
    new URL(urlInput.value.trim())
  } catch {
    errorMessage.value = 'Please enter a valid URL (e.g. http://localhost:3000/__graph-inspector)'
    return
  }

  errorMessage.value = ''
  const encoded = btoa(urlInput.value.trim())
  navigateTo(`/view/${encoded}`)
}
</script>

<template>
  <UContainer class="py-12">
    <div class="flex flex-col items-center justify-center min-h-[60vh] gap-8">
      <!-- Hero Section -->
      <div class="text-center space-y-4">
        <div class="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-2">
          <UIcon
            name="i-lucide-scan-search"
            class="w-8 h-8 text-primary"
          />
        </div>
        <h1 class="text-3xl font-bold tracking-tight">
          Graph Viewer
        </h1>
        <p class="text-muted text-lg max-w-md">
          Visualize your NestJS dependency graph by providing the inspector endpoint URL.
        </p>
      </div>

      <!-- URL Input Card -->
      <div class="w-full max-w-lg">
        <UCard>
          <form
            class="space-y-4"
            @submit.prevent="onSubmit"
          >
            <UFormField
              label="Inspector Endpoint URL"
              :error="errorMessage || undefined"
            >
              <UInput
                v-model="urlInput"
                placeholder="http://localhost:3000/__graph-inspector"
                icon="i-lucide-link"
                size="lg"
                class="w-full"
                autofocus
              />
            </UFormField>

            <UButton
              type="submit"
              label="View Graph"
              icon="i-lucide-arrow-right"
              trailing
              block
              size="lg"
            />
          </form>
        </UCard>

        <p class="text-sm text-muted text-center mt-4">
          Configure the
          <code class="text-xs bg-elevated px-1.5 py-0.5 rounded">http</code>
          output in your NestJS app to expose the endpoint.
        </p>
      </div>
    </div>


  </UContainer>
</template>
