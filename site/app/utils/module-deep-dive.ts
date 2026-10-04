/**
 * One module's own wiring, laid out for the deep-dive page.
 *
 * The navigator draws every module at once, so inside any one of them the
 * question "what does this module need, and from where" is answered by
 * tracing lines across the whole canvas. The deep dive answers it for one
 * module: its providers and controllers, and every dependency it reaches
 * outside itself as a node of its own, laid out so a dependency always sits to
 * the left of whatever injects it.
 *
 * Pure data in, pure data out — the component only renders what this returns.
 */
import type {
  GraphOutput,
  GraphOutputDependencyRef,
  GraphOutputModule
} from 'nest-graph-inspector'
import { getDirectRunNodeId } from './direct-run-provider.ts'

export type ModuleDeepDiveItemKind = 'provider' | 'controller'

/** A provider or controller declared in the module itself. */
export type ModuleDeepDiveItemNode = {
  id: string
  type: 'item'
  kind: ModuleDeepDiveItemKind
  label: string
  /** The module being inspected; it declares every item node. */
  moduleName: string
  isExported: boolean
  jsdoc?: string
  /** Whether the graph advertises any method Direct Run may call. */
  isRunnable: boolean
  position: { x: number, y: number }
}

/** A token the module injects but does not declare, and who provides it. */
export type ModuleDeepDiveExternalNode = {
  id: string
  type: 'external'
  label: string
  /** The module the dependency is provided by. */
  moduleName: string
  position: { x: number, y: number }
}

export type ModuleDeepDiveNode = ModuleDeepDiveItemNode | ModuleDeepDiveExternalNode

/**
 * What an edge draws: a provider injected into a provider, anything injected
 * into a controller, or a dependency reaching outside the module. An external
 * dependency is `external` whatever injects it — where it comes from is the
 * point of the page.
 */
export type ModuleDeepDiveEdgeKind = 'provider' | 'controller' | 'external'

/** From the dependency to whatever injects it, as the navigator draws them. */
export type ModuleDeepDiveEdge = {
  id: string
  source: string
  target: string
  kind: ModuleDeepDiveEdgeKind
}

export type ModuleDeepDiveStats = {
  imports: number
  exports: number
  providers: number
  controllers: number
  /** Distinct injections of one of the module's items into another. */
  internalDependencies: number
  /** Distinct tokens the module injects from somewhere else. */
  externalDependencies: number
}

export type ModuleDeepDive = {
  nodes: ModuleDeepDiveNode[]
  edges: ModuleDeepDiveEdge[]
  stats: ModuleDeepDiveStats
}

export const DEEP_DIVE_ITEM_WIDTH = 220
export const DEEP_DIVE_ITEM_HEIGHT = 36
export const DEEP_DIVE_EXTERNAL_HEIGHT = 52
const COLUMN_GAP = 120
const ROW_GAP = 20

/**
 * The deep dive of `moduleName`, or `null` when the graph has no such module.
 *
 * A dependency is internal only when it resolves to an item the module itself
 * declares. Anything else — another module's export, a NestJS core token, or a
 * token the library attributed to this module but that no item here declares —
 * is drawn as an external node, so nothing the module injects goes missing.
 */
export function buildModuleDeepDive(
  graph: Pick<GraphOutput, 'modules'>,
  moduleName: string
): ModuleDeepDive | null {
  if (!Object.hasOwn(graph.modules, moduleName)) {
    return null
  }

  const mod = graph.modules[moduleName] as GraphOutputModule
  const providerIds = new Map(
    mod.providers.map(provider => [
      provider.name,
      getDirectRunNodeId('provider', moduleName, provider.name)
    ])
  )
  const controllerIds = new Map(
    mod.controllers.map(controller => [
      controller.name,
      getDirectRunNodeId('controller', moduleName, controller.name)
    ])
  )

  function resolveInternalId(dep: GraphOutputDependencyRef): string | null {
    if (dep.providedBy.name !== moduleName) {
      return null
    }

    return providerIds.get(dep.token) ?? controllerIds.get(dep.token) ?? null
  }

  const externals = new Map<string, ModuleDeepDiveExternalNode>()
  const edges = new Map<string, ModuleDeepDiveEdge>()
  // Provider id → the internal providers it injects, for its column.
  const providerDependencies = new Map<string, string[]>()

  const items = [
    ...mod.providers.map(provider => ({
      kind: 'provider' as const,
      entry: provider,
      id: providerIds.get(provider.name) as string
    })),
    ...mod.controllers.map(controller => ({
      kind: 'controller' as const,
      entry: controller,
      id: controllerIds.get(controller.name) as string
    }))
  ]

  for (const { kind, entry, id } of items) {
    const internalDependencies: string[] = []

    for (const dep of entry.dependencies) {
      const internalId = resolveInternalId(dep)

      if (internalId) {
        internalDependencies.push(internalId)
        addEdge(edges, internalId, id, kind === 'controller' ? 'controller' : 'provider')
        continue
      }

      const externalId = getExternalNodeId(dep.providedBy.name, dep.token)
      if (!externals.has(externalId)) {
        externals.set(externalId, {
          id: externalId,
          type: 'external',
          label: dep.token,
          moduleName: dep.providedBy.name,
          position: { x: 0, y: 0 }
        })
      }
      addEdge(edges, externalId, id, 'external')
    }

    if (kind === 'provider') {
      providerDependencies.set(
        id,
        internalDependencies.filter(dependencyId => dependencyId.startsWith('provider-'))
      )
    }
  }

  const providerLevels = resolveDependencyLevels(
    [...providerIds.values()],
    providerDependencies
  )
  const providerColumnCount = Math.max(-1, ...providerLevels.values()) + 1

  // External dependencies first, providers by how deep they inject one
  // another, controllers last — then empty columns are closed up, so a module
  // with no external dependencies does not start with a gap.
  const sortedExternals = [...externals.values()].sort(
    (left, right) =>
      left.moduleName.localeCompare(right.moduleName)
      || left.label.localeCompare(right.label)
  )
  const columns: ModuleDeepDiveNode[][] = [
    sortedExternals,
    ...Array.from({ length: providerColumnCount }, () => [] as ModuleDeepDiveNode[]),
    []
  ]

  for (const { kind, entry, id } of items) {
    const node: ModuleDeepDiveItemNode = {
      id,
      type: 'item',
      kind,
      label: entry.name,
      moduleName,
      isExported: mod.exports.includes(entry.name),
      jsdoc: entry.jsdoc,
      isRunnable: Boolean(entry.directRun?.methods?.length),
      position: { x: 0, y: 0 }
    }

    const column = kind === 'provider'
      ? 1 + (providerLevels.get(id) ?? 0)
      : columns.length - 1
    columns[column]?.push(node)
  }

  const nodes: ModuleDeepDiveNode[] = []
  const filledColumns = columns.filter(column => column.length > 0)

  for (const [columnIndex, column] of filledColumns.entries()) {
    const step = getNodeHeight(column[0] as ModuleDeepDiveNode) + ROW_GAP
    const top = -((column.length - 1) * step) / 2

    for (const [rowIndex, node] of column.entries()) {
      node.position = {
        x: columnIndex * (DEEP_DIVE_ITEM_WIDTH + COLUMN_GAP),
        y: top + rowIndex * step
      }
      nodes.push(node)
    }
  }

  const edgeList = [...edges.values()]

  return {
    nodes,
    edges: edgeList,
    stats: {
      imports: mod.imports.length,
      exports: mod.exports.length,
      providers: mod.providers.length,
      controllers: mod.controllers.length,
      internalDependencies: edgeList.filter(edge => edge.kind !== 'external').length,
      externalDependencies: externals.size
    }
  }
}

/** The node height a layout column is spaced by. */
export function getNodeHeight(node: Pick<ModuleDeepDiveNode, 'type'>): number {
  return node.type === 'external' ? DEEP_DIVE_EXTERNAL_HEIGHT : DEEP_DIVE_ITEM_HEIGHT
}

/**
 * An external node's id. JSON rather than a joined string: module and token
 * names may both contain `-`, and `A-B` + `C` must not meet `A` + `B-C`.
 */
function getExternalNodeId(moduleName: string, token: string): string {
  return `external:${JSON.stringify([moduleName, token])}`
}

function addEdge(
  edges: Map<string, ModuleDeepDiveEdge>,
  source: string,
  target: string,
  kind: ModuleDeepDiveEdgeKind
): void {
  const id = JSON.stringify([source, target])
  if (!edges.has(id)) {
    edges.set(id, { id, source, target, kind })
  }
}

/**
 * How many providers deep each one injects: `0` for a provider that injects
 * none of its siblings, one more than its deepest sibling otherwise. A cycle
 * is cut where it is found, so every provider still gets a level.
 */
function resolveDependencyLevels(
  ids: string[],
  dependencies: Map<string, string[]>
): Map<string, number> {
  const levels = new Map<string, number>()
  const visiting = new Set<string>()

  function visit(id: string): number {
    const known = levels.get(id)
    if (known !== undefined) {
      return known
    }

    visiting.add(id)
    let level = 0
    for (const dependencyId of dependencies.get(id) ?? []) {
      if (dependencyId === id || visiting.has(dependencyId)) {
        continue
      }
      level = Math.max(level, visit(dependencyId) + 1)
    }
    visiting.delete(id)
    levels.set(id, level)

    return level
  }

  for (const id of ids) {
    visit(id)
  }

  return levels
}
