<script setup lang="ts">
import { VueFlow, useVueFlow, Position, Handle, MarkerType } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import type { Node, Edge } from '@vue-flow/core'

interface ModuleProvider {
  name: string
  dependencies: string[]
}

interface ModuleController {
  name: string
  dependencies: string[]
}

interface ModuleData {
  providers: ModuleProvider[]
  controllers: ModuleController[]
  imports: string[]
  exports: string[]
}

interface ModuleMap {
  version: string
  root: string
  modules: Record<string, ModuleData>
}

const props = defineProps<{
  data: ModuleMap
}>()

const { fitView } = useVueFlow()

const NODE_WIDTH = 200
const NODE_HEIGHT = 32
const NODE_GAP = 8
const MODULE_PADDING = 20
const MODULE_TITLE_HEIGHT = 36
const MODULE_WIDTH = NODE_WIDTH + MODULE_PADDING * 2
const EXPORTS_HEIGHT = 24
const MODULE_GAP_X = 320
const MODULE_GAP_Y = 100

function assignLayers(moduleMap: ModuleMap): Map<number, string[]> {
  const layers = new Map<number, string[]>()
  const visited = new Set<string>()
  const queue: { name: string, depth: number }[] = [{ name: moduleMap.root, depth: 0 }]
  visited.add(moduleMap.root)

  while (queue.length > 0) {
    const { name, depth } = queue.shift()!
    if (!layers.has(depth)) layers.set(depth, [])
    layers.get(depth)!.push(name)

    const mod = moduleMap.modules[name]
    if (mod) {
      for (const imp of mod.imports) {
        if (!visited.has(imp) && moduleMap.modules[imp]) {
          visited.add(imp)
          queue.push({ name: imp, depth: depth + 1 })
        }
      }
    }
  }

  for (const name of Object.keys(moduleMap.modules)) {
    if (!visited.has(name)) {
      const maxDepth = Math.max(...Array.from(layers.keys()), 0) + 1
      if (!layers.has(maxDepth)) layers.set(maxDepth, [])
      layers.get(maxDepth)!.push(name)
    }
  }

  return layers
}

function calcModuleHeight(mod: ModuleData): number {
  const itemCount = mod.providers.length + mod.controllers.length
  if (itemCount === 0 && mod.exports.length === 0) {
    return MODULE_TITLE_HEIGHT + MODULE_PADDING * 2 + 16
  }
  let h = MODULE_TITLE_HEIGHT + MODULE_PADDING
  if (itemCount > 0) {
    h += itemCount * NODE_HEIGHT + (itemCount - 1) * NODE_GAP
  }
  if (mod.exports.length > 0) {
    h += (itemCount > 0 ? NODE_GAP : 0) + EXPORTS_HEIGHT
  }
  return h + MODULE_PADDING
}

function resolveDepNodeId(dep: string, currentModule: string, moduleMap: ModuleMap): string | null {
  if (dep.includes(':')) {
    const parts = dep.split(':')
    const modName = parts[0]
    const provName = parts[1]
    if (!modName || !provName) return null
    const mod = moduleMap.modules[modName]
    if (mod) {
      if (mod.providers.some((p: ModuleProvider) => p.name === provName)) return `provider-${modName}-${provName}`
      if (mod.controllers.some((c: ModuleController) => c.name === provName)) return `controller-${modName}-${provName}`
    }
    return null
  }

  const mod = moduleMap.modules[currentModule]
  if (mod) {
    if (mod.providers.some((p: ModuleProvider) => p.name === dep)) return `provider-${currentModule}-${dep}`
    if (mod.controllers.some((c: ModuleController) => c.name === dep)) return `controller-${currentModule}-${dep}`
  }

  for (const [modName, modData] of Object.entries(moduleMap.modules)) {
    if (modData.providers.some((p: ModuleProvider) => p.name === dep)) return `provider-${modName}-${dep}`
    if (modData.controllers.some((c: ModuleController) => c.name === dep)) return `controller-${modName}-${dep}`
  }

  return null
}

function pickHandles(
  sourcePos: { x: number, y: number },
  targetPos: { x: number, y: number }
): { sourceHandle: string, targetHandle: string } {
  const dx = targetPos.x - sourcePos.x
  const dy = targetPos.y - sourcePos.y

  if (dx === 0 && dy === 0) {
    return { sourceHandle: 'source-bottom', targetHandle: 'target-top' }
  }

  if (Math.abs(dy) >= Math.abs(dx)) {
    if (dy > 0) {
      return { sourceHandle: 'source-bottom', targetHandle: 'target-top' }
    }
    return { sourceHandle: 'source-top', targetHandle: 'target-bottom' }
  }

  if (dx > 0) {
    return { sourceHandle: 'source-right', targetHandle: 'target-left' }
  }
  return { sourceHandle: 'source-left', targetHandle: 'target-right' }
}

function buildGraph(moduleMap: ModuleMap): { nodes: Node[], edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const layers = assignLayers(moduleMap)
  const sortedLayers = Array.from(layers.entries()).sort((a, b) => a[0] - b[0])

  const modulePositions = new Map<string, { x: number, y: number }>()
  const nodeToModule = new Map<string, string>()
  const nodeAbsPositions = new Map<string, { x: number, y: number }>()
  let currentY = 0

  for (const [, moduleNames] of sortedLayers) {
    const layerWidth = moduleNames.length * MODULE_GAP_X
    const startX = -(layerWidth / 2) + MODULE_GAP_X / 2

    let maxHeight = 0
    for (let i = 0; i < moduleNames.length; i++) {
      const name = moduleNames[i]!
      const mod = moduleMap.modules[name]
      modulePositions.set(name, { x: startX + i * MODULE_GAP_X, y: currentY })
      if (mod) {
        maxHeight = Math.max(maxHeight, calcModuleHeight(mod))
      }
    }
    currentY += maxHeight + MODULE_GAP_Y
  }

  for (const [moduleName, mod] of Object.entries(moduleMap.modules)) {
    const pos = modulePositions.get(moduleName) || { x: 0, y: 0 }
    const height = calcModuleHeight(mod)

    nodes.push({
      id: `module-${moduleName}`,
      type: 'module',
      position: { x: pos.x, y: pos.y },
      data: {
        label: moduleName,
        isRoot: moduleName === moduleMap.root,
        exports: mod.exports
      },
      style: { width: `${MODULE_WIDTH}px`, height: `${height}px` }
    } as Node)
  }

  for (const [moduleName, mod] of Object.entries(moduleMap.modules)) {
    const modPos = modulePositions.get(moduleName) || { x: 0, y: 0 }
    let itemIndex = 0

    for (const ctrl of mod.controllers) {
      const childY = MODULE_TITLE_HEIGHT + MODULE_PADDING + itemIndex * (NODE_HEIGHT + NODE_GAP)
      const nodeId = `controller-${moduleName}-${ctrl.name}`
      nodeToModule.set(nodeId, moduleName)
      nodeAbsPositions.set(nodeId, {
        x: modPos.x + MODULE_PADDING + NODE_WIDTH / 2,
        y: modPos.y + childY + NODE_HEIGHT / 2
      })
      nodes.push({
        id: nodeId,
        type: 'item',
        position: { x: MODULE_PADDING, y: childY },
        parentNode: `module-${moduleName}`,
        extent: 'parent' as const,
        draggable: false,
        data: { label: ctrl.name },
        style: { width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` }
      } as Node)
      itemIndex++
    }

    for (const prov of mod.providers) {
      const childY = MODULE_TITLE_HEIGHT + MODULE_PADDING + itemIndex * (NODE_HEIGHT + NODE_GAP)
      const nodeId = `provider-${moduleName}-${prov.name}`
      nodeToModule.set(nodeId, moduleName)
      nodeAbsPositions.set(nodeId, {
        x: modPos.x + MODULE_PADDING + NODE_WIDTH / 2,
        y: modPos.y + childY + NODE_HEIGHT / 2
      })
      nodes.push({
        id: nodeId,
        type: 'item',
        position: { x: MODULE_PADDING, y: childY },
        parentNode: `module-${moduleName}`,
        extent: 'parent' as const,
        draggable: false,
        data: { label: prov.name },
        style: { width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` }
      } as Node)
      itemIndex++
    }
  }

  for (const [moduleName, mod] of Object.entries(moduleMap.modules)) {
    for (const imp of mod.imports) {
      if (moduleMap.modules[imp]) {
        const sourcePos = modulePositions.get(imp)!
        const targetPos = modulePositions.get(moduleName)!
        const { sourceHandle, targetHandle } = pickHandles(sourcePos, targetPos)

        edges.push({
          id: `e-mod-${imp}->${moduleName}`,
          source: `module-${imp}`,
          target: `module-${moduleName}`,
          sourceHandle,
          targetHandle,
          type: 'smoothstep',
          style: { stroke: '#888', strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#888' }
        })
      }
    }
  }

  for (const [moduleName, mod] of Object.entries(moduleMap.modules)) {
    for (const provider of mod.providers) {
      for (const dep of provider.dependencies) {
        const sourceId = resolveDepNodeId(dep, moduleName, moduleMap)
        const targetId = `provider-${moduleName}-${provider.name}`
        if (sourceId && nodeAbsPositions.has(sourceId)) {
          const sPos = nodeAbsPositions.get(sourceId)!
          const tPos = nodeAbsPositions.get(targetId)!
          const { sourceHandle, targetHandle } = pickHandles(sPos, tPos)

          edges.push({
            id: `e-dep-${sourceId}->${targetId}`,
            source: sourceId,
            target: targetId,
            sourceHandle,
            targetHandle,
            type: 'smoothstep',
            style: { stroke: '#555', strokeWidth: 1.5 },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#555' }
          })
        }
      }
    }

    for (const controller of mod.controllers) {
      for (const dep of controller.dependencies) {
        const sourceId = resolveDepNodeId(dep, moduleName, moduleMap)
        const targetId = `controller-${moduleName}-${controller.name}`
        if (sourceId && nodeAbsPositions.has(sourceId)) {
          const sPos = nodeAbsPositions.get(sourceId)!
          const tPos = nodeAbsPositions.get(targetId)!
          const { sourceHandle, targetHandle } = pickHandles(sPos, tPos)

          edges.push({
            id: `e-dep-${sourceId}->${targetId}`,
            source: sourceId,
            target: targetId,
            sourceHandle,
            targetHandle,
            type: 'smoothstep',
            style: { stroke: '#555', strokeWidth: 1.5 },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#555' }
          })
        }
      }
    }
  }

  return { nodes, edges }
}

const { nodes, edges } = buildGraph(props.data)

const flowNodes = ref(nodes)
const flowEdges = ref(edges)

onMounted(() => {
  setTimeout(() => fitView({ padding: 0.3 }), 200)
})
</script>

<template>
  <div class="graph-viewer">
    <VueFlow
      v-model:nodes="flowNodes"
      v-model:edges="flowEdges"
      :default-viewport="{ zoom: 0.8, x: 0, y: 0 }"
      :min-zoom="0.05"
      :max-zoom="2"
      fit-view-on-init
      class="graph-flow"
    >
      <template #node-module="moduleProps">
        <Handle
          id="target-top"
          type="target"
          :position="Position.Top"
        />
        <Handle
          id="target-bottom"
          type="target"
          :position="Position.Bottom"
        />
        <Handle
          id="target-left"
          type="target"
          :position="Position.Left"
        />
        <Handle
          id="target-right"
          type="target"
          :position="Position.Right"
        />

        <div
          class="module-subgraph"
          :class="{ 'module-subgraph--root': moduleProps.data.isRoot }"
        >
          <div class="module-subgraph__title">
            {{ moduleProps.data.label }}
          </div>
          <div class="module-subgraph__body" />
          <div
            v-if="moduleProps.data.exports?.length"
            class="module-subgraph__exports"
          >
            Exports: {{ moduleProps.data.exports.join(', ') }}
          </div>
        </div>

        <Handle
          id="source-top"
          type="source"
          :position="Position.Top"
        />
        <Handle
          id="source-bottom"
          type="source"
          :position="Position.Bottom"
        />
        <Handle
          id="source-left"
          type="source"
          :position="Position.Left"
        />
        <Handle
          id="source-right"
          type="source"
          :position="Position.Right"
        />
      </template>

      <template #node-item="itemProps">
        <Handle
          id="target-top"
          type="target"
          :position="Position.Top"
        />
        <Handle
          id="target-bottom"
          type="target"
          :position="Position.Bottom"
        />
        <Handle
          id="target-left"
          type="target"
          :position="Position.Left"
        />
        <Handle
          id="target-right"
          type="target"
          :position="Position.Right"
        />

        <div class="mermaid-node">
          {{ itemProps.data.label }}
        </div>

        <Handle
          id="source-top"
          type="source"
          :position="Position.Top"
        />
        <Handle
          id="source-bottom"
          type="source"
          :position="Position.Bottom"
        />
        <Handle
          id="source-left"
          type="source"
          :position="Position.Left"
        />
        <Handle
          id="source-right"
          type="source"
          :position="Position.Right"
        />
      </template>

      <Background />
      <Controls />
      <MiniMap />
    </VueFlow>
  </div>
</template>

<style>
@import '@vue-flow/core/dist/style.css';
@import '@vue-flow/core/dist/theme-default.css';
@import '@vue-flow/controls/dist/style.css';
@import '@vue-flow/minimap/dist/style.css';

:root {
  --mg-node-bg: #ECECFF;
  --mg-node-border: #9370DB;
  --mg-node-text: #333;
  --mg-subgraph-bg: rgba(236, 236, 255, 0.12);
  --mg-subgraph-border: #bbb;
  --mg-subgraph-title-bg: rgba(0, 0, 0, 0.04);
  --mg-subgraph-title-border: rgba(0, 0, 0, 0.08);
  --mg-root-border: #ff6b6b;
  --mg-root-bg: rgba(255, 107, 107, 0.06);
  --mg-root-title-bg: rgba(255, 107, 107, 0.08);
  --mg-export-color: #10b981;
}

.dark {
  --mg-node-bg: #2d3748;
  --mg-node-border: #7c3aed;
  --mg-node-text: #e2e8f0;
  --mg-subgraph-bg: rgba(255, 255, 255, 0.04);
  --mg-subgraph-border: #4a5568;
  --mg-subgraph-title-bg: rgba(255, 255, 255, 0.06);
  --mg-subgraph-title-border: rgba(255, 255, 255, 0.08);
  --mg-root-border: #f87171;
  --mg-root-bg: rgba(248, 113, 113, 0.08);
  --mg-root-title-bg: rgba(248, 113, 113, 0.1);
  --mg-export-color: #34d399;
}

.graph-viewer {
  width: 100%;
  height: 75vh;
  border-radius: 0.75rem;
  overflow: hidden;
  border: 1px solid var(--mg-subgraph-border);
}

.module-subgraph {
  width: 100%;
  height: 100%;
  background: var(--mg-subgraph-bg);
  border: 2px solid var(--mg-subgraph-border);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  font-family: 'Public Sans', system-ui, sans-serif;
  box-sizing: border-box;
}

.module-subgraph--root {
  border-color: var(--mg-root-border);
  background: var(--mg-root-bg);
}

.module-subgraph__title {
  font-weight: 700;
  font-size: 13px;
  padding: 8px 14px;
  background: var(--mg-subgraph-title-bg);
  border-bottom: 1px solid var(--mg-subgraph-title-border);
  border-radius: 6px 6px 0 0;
}

.module-subgraph--root .module-subgraph__title {
  background: var(--mg-root-title-bg);
}

.module-subgraph__body {
  flex: 1;
}

.module-subgraph__exports {
  font-size: 10px;
  font-weight: 600;
  color: var(--mg-export-color);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 6px 14px;
  border-top: 1px solid var(--mg-subgraph-title-border);
}

.mermaid-node {
  width: 100%;
  height: 100%;
  background: var(--mg-node-bg);
  border: 2px solid var(--mg-node-border);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-family: ui-monospace, 'SF Mono', monospace;
  color: var(--mg-node-text);
  box-sizing: border-box;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vue-flow__node-module {
  padding: 0 !important;
  border: none !important;
  background: none !important;
  box-shadow: none !important;
  border-radius: 0 !important;
}

.vue-flow__node-item {
  padding: 0 !important;
  border: none !important;
  background: none !important;
  box-shadow: none !important;
  border-radius: 0 !important;
}

.vue-flow__handle {
  width: 6px;
  height: 6px;
  min-width: 0;
  min-height: 0;
  opacity: 0;
  border: none;
}
</style>
