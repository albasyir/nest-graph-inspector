import type { GraphOutput } from '@library/libs/nest-graph-inspector/src'
import { defineStore } from 'pinia'

type InspectorEndpointInfo = {
  for?: string
}

type LegacyGraphOutput = Partial<GraphOutput>

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

function appendOutputPath(value: string, fileName: string) {
  if (!value) {
    return ''
  }

  try {
    const url = new URL(value)
    const path = url.pathname.replace(/\/+$/, '')

    url.pathname = `${path}/${fileName}`
    return url.toString()
  } catch {
    return ''
  }
}

function resolveOriginPath(value: string, pathName: string) {
  if (!value) {
    return ''
  }

  try {
    const url = new URL(value)
    url.pathname = `/${pathName.replace(/^\/+/, '')}`
    url.search = ''
    url.hash = ''

    return url.toString()
  } catch {
    return ''
  }
}

function isLegacyGraphOutput(value: unknown): value is LegacyGraphOutput {
  return Boolean(
    value
    && typeof value === 'object'
    && 'version' in value
    && 'root' in value
    && 'modules' in value
  )
}

export const useGraphInspectorStore = defineStore('graph-inspector', () => {
  const encodedUrl = ref('')
  const shouldShowUpdateModal = ref(false)

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

  const informationUrl = computed(() => appendOutputPath(decodedUrl.value, 'information.json'))
  const jsonUrl = computed(() => appendOutputPath(decodedUrl.value, 'output.json'))
  const markdownUrl = computed(() => appendOutputPath(decodedUrl.value, 'output.md'))
  const ollamaUrl = computed(() => resolveOriginPath(decodedUrl.value, 'ollama'))

  const {
    data: endpointInfo,
    execute: executeEndpointInfo,
    clear: clearEndpointInfo
  } = useFetch<InspectorEndpointInfo>(() => informationUrl.value, {
    key: 'graph-inspector-endpoint-info',
    immediate: false,
    server: false,
    watch: false
  })

  const {
    data: legacyGraphData,
    execute: executeLegacyGraph,
    clear: clearLegacyGraph
  } = useFetch<LegacyGraphOutput>(() => decodedUrl.value, {
    key: 'graph-inspector-legacy-graph',
    immediate: false,
    server: false,
    watch: false
  })

  const {
    data: graphData,
    status,
    error,
    execute: executeJson,
    clear: clearJson
  } = useFetch<GraphOutput>(() => jsonUrl.value, {
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

  function clearGraph() {
    clearEndpointInfo()
    clearLegacyGraph()
    clearJson()
    clearMarkdown()
    shouldShowUpdateModal.value = false
  }

  async function validateEndpoint() {
    if (!informationUrl.value) {
      clearEndpointInfo()
      return false
    }

    await executeEndpointInfo()

    const isValidEndpoint = endpointInfo.value?.for === 'nest-graph-inspector'
    if (isValidEndpoint) {
      shouldShowUpdateModal.value = false
      return true
    }

    await executeLegacyGraph()
    shouldShowUpdateModal.value = isLegacyGraphOutput(legacyGraphData.value)

    return false
  }

  async function fetchJson() {
    if (!jsonUrl.value) {
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
      clearGraph()
    }

    const isValidEndpoint = await validateEndpoint()
    if (!isValidEndpoint) {
      return false
    }

    return await fetchJson()
  }

  async function setInputUrl(input: string) {
    const sourceUrl = normalizeSourceUrl(input)
    return await setEncodedUrl(encodeURIComponent(btoa(sourceUrl)))
  }

  async function fetchGraph() {
    const isValidEndpoint = await validateEndpoint()
    if (!isValidEndpoint) {
      return false
    }

    const jsonLoaded = await fetchJson()
    if (jsonLoaded) {
      await fetchMarkdown()
    }

    return jsonLoaded
  }

  return {
    encodedUrl,
    decodedUrl,
    informationUrl,
    jsonUrl,
    markdownUrl,
    ollamaUrl,
    graphData,
    graphMarkdown,
    status,
    error,
    errorMessage,
    shouldShowUpdateModal,
    validateEndpoint,
    setEncodedUrl,
    setInputUrl,
    fetchJson,
    fetchMarkdown,
    fetchGraph
  }
})
