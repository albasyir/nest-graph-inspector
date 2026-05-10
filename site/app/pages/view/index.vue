<script setup lang="ts">
useSeoMeta({
  title: 'Graph Viewer',
  ogTitle: 'Graph Viewer - Nest Graph Inspector',
  description: 'View your NestJS dependency graph in real-time by providing the inspector endpoint URL.'
})

const posthog = usePostHog()
const route = useRoute()
const graphStore = useGraphInspectorStore()
const urlInput = ref('')
const errorMessage = ref('')
const isSubmitting = ref(false)

function loadExample() {
  const config = useRuntimeConfig()
  let base = config.app.baseURL || '/'
  if (!base.endsWith('/')) base += '/'
  urlInput.value = `${window.location.origin}${base}mock-graph`
}

async function onSubmit() {
  const input = urlInput.value.trim()
  if (!input) {
    errorMessage.value = 'Please enter a valid URL'
    return
  }

  isSubmitting.value = true

  try {
    const isLoaded = await graphStore.setInputUrl(input)
    if (!isLoaded) {
      errorMessage.value = graphStore.shouldShowUpdateModal
        ? ''
        : graphStore.errorMessage || 'Could not fetch graph JSON from the provided URL.'
      return
    }
  } catch {
    errorMessage.value = 'Please enter a valid URL (e.g. localhost:3000)'
    return
  } finally {
    isSubmitting.value = false
  }

  errorMessage.value = ''
  posthog?.capture('graph_url_submitted', {
    url: graphStore.decodedUrl
  })
  navigateTo(`/view/${graphStore.encodedUrl}`)
}

onMounted(() => {
  if (route.query.preview == 'true') {
    loadExample()
    onSubmit()
  }
})
</script>

<template>
  <UContainer class="py-4 flex items-center justify-center min-h-[calc(100vh-140px)]">
    <GraphInspectorUpdateModal />

    <div class="w-full max-w-2xl space-y-6">
      <!-- Hero Section -->
      <div class="text-center space-y-2">
        <UIcon
          name="i-lucide-network"
          class="w-10 h-10 text-primary mx-auto opacity-80"
        />
        <h1 class="text-3xl font-bold tracking-tight">
          Graph Viewer
        </h1>
        <p class="text-muted text-base max-w-md mx-auto">
          Visualize your NestJS dependency graph by providing the inspector endpoint URL.
        </p>
      </div>

      <!-- Main Card -->
      <form
        class="w-full"
        @submit.prevent="onSubmit"
      >
        <UCard
          class="w-full"
          :ui="{ body: 'p-4 sm:p-5', footer: 'p-4 sm:p-5' }"
        >
          <div class="space-y-5">
            <!-- Instructions Alert -->
            <UAlert
              icon="i-lucide-info"
              title="Prerequisite"
              color="neutral"
              variant="subtle"
            >
              <template #description>
                Configure the <code class="text-xs bg-neutral-200 dark:bg-neutral-800 px-1 py-0.5 rounded font-mono mx-1">http</code> output in your NestJS app to expose the graph endpoint.
              </template>
            </UAlert>

            <!-- URL Input Form Field -->
            <UFormField
              label="NestJS Origin"
              :error="errorMessage || undefined"
              class="w-full"
            >
              <template #hint>
                <UButton
                  variant="link"
                  color="primary"
                  class="p-0 h-auto font-medium"
                  @click="loadExample"
                >
                  Load Example
                </UButton>
              </template>
              <template #description>
                Your running application URL (e.g., localhost:3000)
              </template>
              <UInput
                v-model="urlInput"
                placeholder="http://localhost:3000"
                icon="i-lucide-link"
                size="xl"
                class="w-full font-mono text-lg"
                autofocus
              />
            </UFormField>
          </div>

          <!-- Card Footer for Call to Actions -->
          <template #footer>
            <div class="flex flex-col sm:flex-row items-center justify-between gap-4">
              <UButton
                to="/getting-started/installation"
                label="Installation Guidelines"
                color="neutral"
                variant="subtle"
                icon="i-lucide-book-open"
                class="w-full sm:w-auto justify-center"
              />
              <UButton
                type="submit"
                label="Inspect Graph"
                icon="i-lucide-search"
                trailing
                size="lg"
                class="w-full sm:w-auto justify-center"
                :loading="isSubmitting"
                :disabled="!urlInput.trim() || isSubmitting"
              />
            </div>
          </template>
        </UCard>
      </form>
    </div>
  </UContainer>
</template>
