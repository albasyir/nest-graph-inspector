<script setup lang="ts">
import { VueMonacoEditor, loader } from '@guolao/vue-monaco-editor'
import type { MonacoEditor } from '@guolao/vue-monaco-editor'
import type * as Monaco from 'monaco-editor'

type JsonSchema = Monaco.json.JSONSchema

const model = defineModel<string>({ default: '' })
const emit = defineEmits<{
  validate: [markers: Monaco.editor.IMarker[]]
}>()
const props = withDefaults(
  defineProps<{
    height?: string
    path?: string
    readonly?: boolean
    schema?: JsonSchema
  }>(),
  {
    height: '220px',
    path: undefined,
    readonly: false,
    schema: undefined
  }
)

let isMonacoConfigured = false
const MONACO_CDN_VERSION = '0.55.1'
const registeredJsonSchemas = new Map<string, JsonSchema>()
let activeMonaco: MonacoEditor | null = null
const schemaFingerprint = computed(() =>
  props.schema ? JSON.stringify(props.schema) : ''
)

function configureMonaco(): void {
  if (isMonacoConfigured) {
    return
  }

  loader.config({
    paths: {
      vs: `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_CDN_VERSION}/min/vs`
    }
  })
  isMonacoConfigured = true
}

configureMonaco()

function getJsonSchemaUri(path: string): string {
  return `json-monaco-editor://${encodeURIComponent(path)}.schema.json`
}

function applyJsonSchemas(monaco: MonacoEditor): void {
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    schemaValidation: 'error',
    trailingCommas: 'error',
    schemas: Array.from(registeredJsonSchemas.entries()).map(([path, schema]) => ({
      uri: getJsonSchemaUri(path),
      fileMatch: [path],
      schema
    }))
  })
}

function syncJsonSchema(monaco: MonacoEditor): void {
  if (props.path) {
    if (props.schema) {
      registeredJsonSchemas.set(props.path, props.schema)
    } else {
      registeredJsonSchemas.delete(props.path)
    }
  }

  applyJsonSchemas(monaco)
}

function handleBeforeMount(monaco: MonacoEditor): void {
  activeMonaco = monaco
  syncJsonSchema(monaco)
}

function handleValidate(markers: Monaco.editor.IMarker[]): void {
  emit('validate', markers)
}

watch(
  [() => props.path, schemaFingerprint],
  ([path], [previousPath]) => {
    if (previousPath && previousPath !== path) {
      registeredJsonSchemas.delete(previousPath)
    }

    if (activeMonaco) {
      syncJsonSchema(activeMonaco)
    }
  }
)

onUnmounted(() => {
  if (props.path) {
    registeredJsonSchemas.delete(props.path)
  }

  if (activeMonaco) {
    applyJsonSchemas(activeMonaco)
  }
})

const editorOptions = computed(() =>
  markRaw({
    automaticLayout: true,
    bracketPairColorization: {
      enabled: true
    },
    folding: true,
    fixedOverflowWidgets: true,
    formatOnPaste: true,
    formatOnType: true,
    glyphMargin: false,
    hover: {
      above: false,
      delay: 200,
      sticky: true
    },
    insertSpaces: true,
    lineDecorationsWidth: 12,
    lineNumbers: 'on',
    minimap: {
      enabled: false
    },
    padding: {
      top: 22,
      bottom: 18
    },
    readOnly: props.readonly,
    renderValidationDecorations: 'on',
    renderLineHighlight: 'line',
    scrollBeyondLastLine: false,
    scrollbar: {
      horizontalScrollbarSize: 10,
      verticalScrollbarSize: 10
    },
    tabSize: 2,
    wordWrap: 'on'
  })
)
</script>

<template>
  <div class="json-monaco-editor">
    <VueMonacoEditor
      v-model:value="model"
      language="json"
      theme="vs-dark"
      :path="props.path"
      :height="props.height"
      :options="editorOptions"
      width="100%"
      @before-mount="handleBeforeMount"
      @validate="handleValidate"
    >
      <div class="json-monaco-editor__state">
        Loading editor...
      </div>

      <template #failure>
        <div class="json-monaco-editor__state json-monaco-editor__state--error">
          Editor failed to load.
        </div>
      </template>
    </VueMonacoEditor>
  </div>
</template>

<style scoped>
.json-monaco-editor {
  overflow: visible;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: #1e1e1e;
}

.json-monaco-editor :deep(.monaco-editor),
.json-monaco-editor :deep(.overflow-guard) {
  border-radius: 7px;
}

.json-monaco-editor :deep(.monaco-hover) {
  max-width: calc(100vw - 48px);
}

.json-monaco-editor__state {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 220px;
  color: var(--ui-text-muted);
  font-size: 13px;
}

.json-monaco-editor__state--error {
  color: var(--ui-error);
}
</style>
