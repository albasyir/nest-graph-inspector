import type { GraphOutput } from 'nest-graph-inspector'
import { defineStore } from 'pinia'
import { requiresVersionAcknowledgement } from '~/utils/graph-inspector-version-gate'

type InspectorEndpointInfo = {
  for?: string
  'is-static'?: boolean
  isLatestVersion?: unknown
  latestVersion?: string | null
  version?: unknown
}

type LegacyGraphOutput = Partial<GraphOutput>
const MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION = 3

function withDefaultProtocol(input: string) {
  return input.startsWith('http://') || input.startsWith('https://')
    ? input
    : `http://${input}`
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
    value &&
    typeof value === 'object' &&
    'version' in value &&
    'root' in value &&
    'modules' in value,
  )
}

function parseGraphOutputVersion(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null
  }

  const parsedVersion = Number.parseInt(String(value), 10)
  return Number.isFinite(parsedVersion) ? parsedVersion : null
}

function isSupportedGraphOutputVersion(value: unknown): boolean {
  const parsedVersion = parseGraphOutputVersion(value)
  return (
    parsedVersion !== null
    && parsedVersion >= MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION
  )
}

export const useGraphInspectorStore = defineStore('graph-inspector', () => {
  const encodedUrl = ref('')
  const shouldShowUpdateModal = ref(false)
  const shouldShowVersionAcknowledgement = ref(false)
  const acknowledgedVersionEndpointUrl = ref('')
  const dependencyTraceEnabled = ref(false)
  const showCircularDependencies = ref(true)
  const openModuleDetail = ref(false)
  let resolveVersionAcknowledgement: ((acknowledged: boolean) => void) | undefined

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

  const informationUrl = computed(() =>
    appendOutputPath(decodedUrl.value, 'information.json'),
  )
  const jsonUrl = computed(() =>
    appendOutputPath(decodedUrl.value, 'output.json'),
  )
  const markdownUrl = computed(() =>
    appendOutputPath(decodedUrl.value, 'output.md'),
  )
  const ollamaUrl = computed(() =>
    resolveOriginPath(decodedUrl.value, 'ollama'),
  )

  const {
    data: endpointInfo,
    execute: executeEndpointInfo,
    clear: clearEndpointInfo,
  } = useFetch<InspectorEndpointInfo>(() => informationUrl.value, {
    key: 'graph-inspector-endpoint-info',
    immediate: false,
    server: false,
    watch: false,
  })

  const {
    data: legacyGraphData,
    execute: executeLegacyGraph,
    clear: clearLegacyGraph,
  } = useFetch<LegacyGraphOutput>(() => decodedUrl.value, {
    key: 'graph-inspector-legacy-graph',
    immediate: false,
    server: false,
    watch: false,
  })

  const {
    data: graphData,
    status,
    error,
    execute: executeJson,
    clear: clearJson,
  } = useFetch<GraphOutput>(() => jsonUrl.value, {
    key: 'graph-inspector-json',
    immediate: false,
    server: false,
    watch: false,
  })

  const {
    data: graphMarkdown,
    execute: executeMarkdown,
    clear: clearMarkdown,
  } = useFetch<string>(() => markdownUrl.value, {
    key: 'graph-inspector-markdown',
    default: () => '',
    immediate: false,
    server: false,
    watch: false,
  })

  const errorMessage = computed(() => error.value?.message || '')
  const graphIsStatic = computed(() => endpointInfo.value?.['is-static'] === true)
  const endpointVersion = computed(() => endpointInfo.value?.version)
  const latestVersion = computed(() => {
    const version = endpointInfo.value?.latestVersion
    return typeof version === 'string' && version.trim() ? version : null
  })

  function toggleDependencyTrace() {
    dependencyTraceEnabled.value = !dependencyTraceEnabled.value
  }

  function clearGraph() {
    clearEndpointInfo()
    clearLegacyGraph()
    clearJson()
    clearMarkdown()
    shouldShowUpdateModal.value = false
    shouldShowVersionAcknowledgement.value = false
    acknowledgedVersionEndpointUrl.value = ''
    resolveVersionAcknowledgement?.(false)
    resolveVersionAcknowledgement = undefined
  }

  async function acknowledgeEndpointVersion() {
    acknowledgedVersionEndpointUrl.value = decodedUrl.value
    shouldShowVersionAcknowledgement.value = false
    resolveVersionAcknowledgement?.(true)
    resolveVersionAcknowledgement = undefined
  }

  async function ensureEndpointVersionAcknowledged() {
    if (
      !requiresVersionAcknowledgement(
        endpointInfo.value?.isLatestVersion,
        endpointInfo.value?.['is-static'],
      )
      || acknowledgedVersionEndpointUrl.value === decodedUrl.value
    ) {
      return true
    }

    shouldShowVersionAcknowledgement.value = true
    return await new Promise<boolean>((resolve) => {
      resolveVersionAcknowledgement = resolve
    })
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
    if (status.value !== 'success') {
      shouldShowUpdateModal.value = false
      return false
    }

    const hasSupportedVersion = isSupportedGraphOutputVersion(
      graphData.value?.version,
    )

    shouldShowUpdateModal.value = !hasSupportedVersion
    return hasSupportedVersion
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

    if (!await ensureEndpointVersionAcknowledged()) {
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

    if (!await ensureEndpointVersionAcknowledged()) {
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
    graphIsStatic,
    endpointVersion,
    latestVersion,
    status,
    error,
    errorMessage,
    shouldShowUpdateModal,
    shouldShowVersionAcknowledgement,
    dependencyTraceEnabled,
    showCircularDependencies,
    openModuleDetail,
    toggleDependencyTrace,
    validateEndpoint,
    acknowledgeEndpointVersion,
    setEncodedUrl,
    setInputUrl,
    fetchJson,
    fetchMarkdown,
    fetchGraph,
  }
})
