import type { GraphOutput } from '@library/libs/nest-graph-inspector/src'
import { defineStore } from 'pinia'

function withDefaultProtocol(input: string) {
  return input.startsWith('http://') || input.startsWith('https://') ? input : `http://${input}`
}

function normalizeSourceUrl(input: string) {
  const url = new URL(withDefaultProtocol(input.trim()))

  if (url.pathname === '/' || !url.pathname) {
    url.pathname = '/__graph-inspector'
  }

  return url.toString()
}

export const useGraphInspectorStore = defineStore('graph-inspector', () => {
  const encodedUrl = ref('')

  const decodedUrl = computed(() => {
    if (!encodedUrl.value) {
      return ''
    }

    try {
      return atob(decodeURIComponent(encodedUrl.value))
    } catch {
      return ''
    }
  })

  const markdownUrl = computed(() => {
    if (!decodedUrl.value) {
      return ''
    }

    try {
      const url = new URL(decodedUrl.value)
      const path = url.pathname.replace(/\/+$/, '')

      url.pathname = `${path}/output.md`
      return url.toString()
    } catch {
      return ''
    }
  })

  const {
    data: graphData,
    status,
    error,
    execute: executeJson,
    clear: clearJson
  } = useFetch<GraphOutput>(() => decodedUrl.value, {
    key: 'graph-inspector-json',
    immediate: false,
    server: false,
    watch: false
  })

  const {
    data: graphMarkdown,
    execute: executeMarkdown,
    clear: clearMarkdown
  } = useFetch<string>(() => markdownUrl.value, {
    key: 'graph-inspector-markdown',
    default: () => '',
    immediate: false,
    server: false,
    watch: false
  })

  const errorMessage = computed(() => error.value?.message || '')

  async function fetchJson() {
    if (!decodedUrl.value) {
      clearJson()
      return false
    }

    await executeJson()
    return status.value === 'success'
  }

  async function fetchMarkdown() {
    if (!markdownUrl.value) {
      clearMarkdown()
      return false
    }

    await executeMarkdown()
    return Boolean(graphMarkdown.value)
  }

  async function setEncodedUrl(value: string) {
    if (encodedUrl.value !== value) {
      encodedUrl.value = value
      clearJson()
      clearMarkdown()
    }

    return await fetchJson()
  }

  async function setInputUrl(input: string) {
    const sourceUrl = normalizeSourceUrl(input)
    return await setEncodedUrl(encodeURIComponent(btoa(sourceUrl)))
  }

  async function fetchGraph() {
    const jsonLoaded = await fetchJson()
    if (jsonLoaded) {
      await fetchMarkdown()
    }

    return jsonLoaded
  }

  return {
    encodedUrl,
    decodedUrl,
    markdownUrl,
    graphData,
    graphMarkdown,
    status,
    error,
    errorMessage,
    setEncodedUrl,
    setInputUrl,
    fetchJson,
    fetchMarkdown,
    fetchGraph
  }
})
