<script setup lang="ts">
/**
 * Stands in for a printed viewer link while it is being spent.
 *
 * `/view/<base64url(endpoint)>` matches nothing else, and
 * `middleware/graph-viewer-bootstrap.global.ts` redirects away from it before
 * this is ever created. It exists so that route still resolves at all: without
 * it, a printed link would be a 404 the moment the redirect ever failed to fire.
 */
definePageMeta({
  layout: 'viewer'
})

useSeoMeta({
  title: 'Graph Viewer',
  ogTitle: 'Graph Viewer - Nest Graph Inspector',
  description: 'Opening a NestJS dependency graph.'
})
</script>

<template>
  <GraphViewerLoadingState />
</template>
