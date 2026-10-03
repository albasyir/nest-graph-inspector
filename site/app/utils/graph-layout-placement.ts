import type {
  GraphLayout,
  GraphLayoutModule,
  GraphLayoutPosition,
  GraphOutput,
  GraphOutputModule
} from 'nest-graph-inspector'

/**
 * Where a saved layout meets a graph that has moved on since it was saved.
 *
 * A layout file is committed and outlives the graph it was drawn for: modules
 * and providers are added after someone arranged the canvas. Whatever the file
 * says is kept exactly — a saved module or item never moves, because moving it
 * would undo somebody's arrangement — and only what the file has never seen is
 * placed, in space nothing saved occupies.
 */

/** The sizes `GraphViewer.vue` draws with, so placement agrees with rendering. */
export const LAYOUT_GEOMETRY = {
  nodeWidth: 200,
  nodeHeight: 32,
  nodeGapX: 52,
  nodeGapY: 72,
  modulePadding: 20,
  moduleTitleHeight: 36,
  moduleCollapsedHeight: 40,
  moduleGapX: 320,
  moduleGapY: 100
} as const

const MODULE_MIN_WIDTH
  = LAYOUT_GEOMETRY.nodeWidth + LAYOUT_GEOMETRY.modulePadding * 2

/** Space kept clear around a placed item, smaller than either grid gap. */
const ITEM_CLEARANCE = 16

/** Space kept clear around a placed module. */
const MODULE_CLEARANCE = 40

/** Items per row when nothing better is known about a module's items. */
const DEFAULT_ROW_LENGTH = 4

/** Bounds the free-slot search; far beyond any graph a viewer can draw. */
const MAX_SEARCH_RINGS = 10_000

export type LayoutSize = { width: number, height: number }

export type ResolvedModuleLayout = {
  position: GraphLayoutPosition
  size: LayoutSize
  /** Whether the visitor has the module collapsed. */
  isCollapsed: boolean
  /** Whether the module has any items to show when expanded. */
  isExpandable: boolean
  /** Item positions relative to the module, keyed by the viewer's item id. */
  items: Map<string, GraphLayoutPosition>
  /** Whether the module's position came from the saved layout. */
  isSaved: boolean
}

export type IncrementalLayout = {
  modules: Map<string, ResolvedModuleLayout>
  /** Modules the saved layout did not have, in graph order. */
  newModules: string[]
  /** Item ids the saved layout did not have, in graph order. */
  newItems: string[]
}

export type ResolveIncrementalLayoutParams = {
  moduleMap: GraphOutput
  layout: GraphLayout | null
  collapsedModules: Set<string>
  /**
   * Rows of item ids for a module none of whose items were saved. The viewer
   * passes its dependency hierarchy; without it, items fill rows in graph order.
   */
  defaultItemRows?: (moduleName: string, mod: GraphOutputModule) => string[][]
}

type Rect = { x: number, y: number, width: number, height: number }

/** The id `GraphViewer.vue` gives a provider's or controller's node. */
export function moduleItemIds(
  moduleName: string,
  mod: GraphOutputModule
): string[] {
  return [
    ...mod.providers.map(provider => `provider-${moduleName}-${provider.name}`),
    ...mod.controllers.map(
      controller => `controller-${moduleName}-${controller.name}`
    )
  ]
}

/** The modules a saved layout has collapsed, to seed the viewer's own state. */
export function collapsedModulesFromLayout(
  layout: GraphLayout | null
): Set<string> {
  return new Set(
    Object.entries(layout?.modules ?? {})
      .filter(([, module]) => module.isCollapsed === true)
      .map(([name]) => name)
  )
}

/**
 * Positions every module and item of `moduleMap`.
 *
 * Saved modules and items keep their saved positions exactly. An item the
 * layout has not seen goes into the first free slot of its module's item grid,
 * and the module grows to fit. A module the layout has not seen goes beside a
 * module it imports or that imports it when there is room, and otherwise into
 * the nearest free slot — without displacing anything already placed.
 */
export function resolveIncrementalLayout(
  params: ResolveIncrementalLayoutParams
): IncrementalLayout {
  const { moduleMap, layout, collapsedModules, defaultItemRows } = params
  const savedModules = layout?.modules ?? {}
  const modules = new Map<string, ResolvedModuleLayout>()
  const newModules: string[] = []
  const newItems: string[] = []

  for (const [moduleName, mod] of Object.entries(moduleMap.modules)) {
    const saved = Object.hasOwn(savedModules, moduleName)
      ? savedModules[moduleName]
      : undefined
    const ids = moduleItemIds(moduleName, mod)
    const { items, placedIds } = resolveItems(
      ids,
      saved,
      defaultItemRows?.(moduleName, mod)
    )
    newItems.push(...placedIds)

    const isCollapsed = collapsedModules.has(moduleName)
    const isExpandable = ids.length > 0
    modules.set(moduleName, {
      position: saved ? { ...saved.position } : { x: 0, y: 0 },
      size:
        isCollapsed || !isExpandable
          ? {
              width: MODULE_MIN_WIDTH,
              height: LAYOUT_GEOMETRY.moduleCollapsedHeight
            }
          : sizeForItems(items),
      isCollapsed,
      isExpandable,
      items,
      isSaved: Boolean(saved)
    })

    if (!saved) {
      newModules.push(moduleName)
    }
  }

  const placed = new Map<string, Rect>()
  for (const [moduleName, module] of modules) {
    if (module.isSaved) {
      placed.set(moduleName, toRect(module.position, module.size))
    }
  }

  for (const moduleName of newModules) {
    const module = modules.get(moduleName)!
    module.position = findModulePosition(
      moduleName,
      module.size,
      placed,
      moduleMap
    )
    placed.set(moduleName, toRect(module.position, module.size))
  }

  return { modules, newModules, newItems }
}

/** What a resolved layout looks like saved, ready to send or download. */
export function toGraphLayout(resolved: IncrementalLayout): GraphLayout {
  const modules: Record<string, GraphLayoutModule> = {}

  for (const [moduleName, module] of resolved.modules) {
    modules[moduleName] = {
      position: { ...module.position },
      ...(module.isCollapsed ? { isCollapsed: true } : {}),
      ...(module.items.size
        ? {
            items: Object.fromEntries(
              [...module.items].map(([id, position]) => [id, { ...position }])
            )
          }
        : {})
    }
  }

  return { version: '1', modules }
}

function resolveItems(
  ids: string[],
  saved: GraphLayoutModule | undefined,
  defaultRows: string[][] | undefined
): { items: Map<string, GraphLayoutPosition>, placedIds: string[] } {
  const savedItems = saved?.items ?? {}
  const lockedIds = ids.filter(id => Object.hasOwn(savedItems, id))
  const placedIds = ids.filter(id => !Object.hasOwn(savedItems, id))
  const items = new Map<string, GraphLayoutPosition>()

  if (!lockedIds.length) {
    placeInRows(normalizeRows(defaultRows, ids), items)
    return { items, placedIds }
  }

  for (const id of lockedIds) {
    items.set(id, { ...savedItems[id]! })
  }

  const { nodeWidth, nodeHeight, nodeGapX, nodeGapY, modulePadding }
    = LAYOUT_GEOMETRY
  const originX = modulePadding
  const originY = LAYOUT_GEOMETRY.moduleTitleHeight + modulePadding
  const pitchX = nodeWidth + nodeGapX
  const pitchY = nodeHeight + nodeGapY
  const occupied = lockedIds.map(id => itemRect(items.get(id)!))
  const savedRight = Math.max(...occupied.map(rect => rect.x + rect.width))
  // As many columns as the saved items already span, so a new item fills a gap
  // the module already has before it makes the module wider.
  const columns = Math.max(
    1,
    Math.floor((savedRight - originX + nodeGapX) / pitchX)
  )

  for (const id of placedIds) {
    for (let slot = 0; ; slot += 1) {
      const position = {
        x: originX + (slot % columns) * pitchX,
        y: originY + Math.floor(slot / columns) * pitchY
      }
      const rect = itemRect(position)

      if (!occupied.some(other => overlaps(rect, other, ITEM_CLEARANCE))) {
        items.set(id, position)
        occupied.push(rect)
        break
      }
    }
  }

  return { items, placedIds }
}

/** Keeps rows to this module's own items, each once, and appends the rest. */
function normalizeRows(
  rows: string[][] | undefined,
  ids: string[]
): string[][] {
  const known = new Set(ids)
  const seen = new Set<string>()
  const normalized = (rows ?? [])
    .map(row =>
      row.filter((id) => {
        if (!known.has(id) || seen.has(id)) {
          return false
        }
        seen.add(id)
        return true
      })
    )
    .filter(row => row.length > 0)

  const rest = ids.filter(id => !seen.has(id))
  for (let index = 0; index < rest.length; index += DEFAULT_ROW_LENGTH) {
    normalized.push(rest.slice(index, index + DEFAULT_ROW_LENGTH))
  }

  return normalized
}

/** Centred rows, exactly as `GraphViewer.vue` lays out a module by default. */
function placeInRows(
  rows: string[][],
  items: Map<string, GraphLayoutPosition>
): void {
  const { nodeWidth, nodeHeight, nodeGapX, nodeGapY, modulePadding }
    = LAYOUT_GEOMETRY
  const rowWidth = (count: number) =>
    count * nodeWidth + Math.max(count - 1, 0) * nodeGapX
  const width = Math.max(
    MODULE_MIN_WIDTH,
    modulePadding * 2 + rowWidth(Math.max(...rows.map(row => row.length), 1))
  )

  for (const [rowIndex, row] of rows.entries()) {
    const startX = Math.max(modulePadding, (width - rowWidth(row.length)) / 2)
    const y
      = LAYOUT_GEOMETRY.moduleTitleHeight
        + modulePadding
        + rowIndex * (nodeHeight + nodeGapY)

    for (const [itemIndex, id] of row.entries()) {
      items.set(id, { x: startX + itemIndex * (nodeWidth + nodeGapX), y })
    }
  }
}

/** Large enough to hold every item with the module's padding around them. */
function sizeForItems(items: Map<string, GraphLayoutPosition>): LayoutSize {
  const { nodeWidth, nodeHeight, modulePadding, moduleTitleHeight }
    = LAYOUT_GEOMETRY
  let right = 0
  let bottom = 0

  for (const position of items.values()) {
    right = Math.max(right, position.x + nodeWidth)
    bottom = Math.max(bottom, position.y + nodeHeight)
  }

  return {
    width: Math.max(MODULE_MIN_WIDTH, right + modulePadding),
    height: Math.max(
      moduleTitleHeight + modulePadding * 2 + nodeHeight,
      bottom + modulePadding
    )
  }
}

function findModulePosition(
  moduleName: string,
  size: LayoutSize,
  placed: Map<string, Rect>,
  moduleMap: GraphOutput
): GraphLayoutPosition {
  if (!placed.size) {
    return { x: 0, y: 0 }
  }

  const isFree = (position: GraphLayoutPosition) => {
    const rect = toRect(position, size)
    return ![...placed.values()].some(other =>
      overlaps(rect, other, MODULE_CLEARANCE)
    )
  }

  const neighbors = connectedModules(moduleName, moduleMap)
    .map(name => placed.get(name))
    .filter((rect): rect is Rect => Boolean(rect))
  const { moduleGapX, moduleGapY } = LAYOUT_GEOMETRY

  for (const neighbor of neighbors) {
    const beside = [
      { x: neighbor.x + neighbor.width + moduleGapX, y: neighbor.y },
      { x: neighbor.x, y: neighbor.y + neighbor.height + moduleGapY },
      { x: neighbor.x - size.width - moduleGapX, y: neighbor.y },
      { x: neighbor.x, y: neighbor.y - size.height - moduleGapY }
    ].find(isFree)

    if (beside) {
      return beside
    }
  }

  const anchor = neighbors[0] ?? boundingBox([...placed.values()])
  return nearestFreeSlot(
    { x: anchor.x, y: anchor.y },
    { width: size.width + moduleGapX, height: size.height + moduleGapY },
    isFree
  )
}

/** Modules this one imports, then modules importing it, in graph order. */
function connectedModules(moduleName: string, moduleMap: GraphOutput): string[] {
  const imports = moduleMap.modules[moduleName]?.imports ?? []
  const dependents = Object.entries(moduleMap.modules)
    .filter(([, mod]) => mod.imports.includes(moduleName))
    .map(([name]) => name)

  return [...new Set([...imports, ...dependents])].filter(
    name => name !== moduleName
  )
}

/**
 * Grid cells around `anchor`, ring by ring and nearest first within a ring,
 * until one is free. Something is always free outside everything placed.
 */
function nearestFreeSlot(
  anchor: GraphLayoutPosition,
  step: LayoutSize,
  isFree: (position: GraphLayoutPosition) => boolean
): GraphLayoutPosition {
  for (let ring = 0; ring <= MAX_SEARCH_RINGS; ring += 1) {
    const cells: Array<{ column: number, row: number }> = []
    for (let row = -ring; row <= ring; row += 1) {
      for (let column = -ring; column <= ring; column += 1) {
        if (Math.max(Math.abs(row), Math.abs(column)) === ring) {
          cells.push({ column, row })
        }
      }
    }

    cells.sort(
      (left, right) =>
        left.column ** 2
        + left.row ** 2
        - (right.column ** 2 + right.row ** 2)
        || left.row - right.row
        || left.column - right.column
    )

    for (const { column, row } of cells) {
      const position = {
        x: anchor.x + column * step.width,
        y: anchor.y + row * step.height
      }
      if (isFree(position)) {
        return position
      }
    }
  }

  throw new Error('No free position found for a module.')
}

function boundingBox(rects: Rect[]): Rect {
  const x = Math.min(...rects.map(rect => rect.x))
  const y = Math.min(...rects.map(rect => rect.y))

  return {
    x,
    y,
    width: Math.max(...rects.map(rect => rect.x + rect.width)) - x,
    height: Math.max(...rects.map(rect => rect.y + rect.height)) - y
  }
}

function itemRect(position: GraphLayoutPosition): Rect {
  return toRect(position, {
    width: LAYOUT_GEOMETRY.nodeWidth,
    height: LAYOUT_GEOMETRY.nodeHeight
  })
}

function toRect(position: GraphLayoutPosition, size: LayoutSize): Rect {
  return { x: position.x, y: position.y, ...size }
}

/** Whether two rectangles come closer than `clearance` on both axes. */
function overlaps(a: Rect, b: Rect, clearance: number): boolean {
  return (
    a.x < b.x + b.width + clearance
    && b.x < a.x + a.width + clearance
    && a.y < b.y + b.height + clearance
    && b.y < a.y + a.height + clearance
  )
}
