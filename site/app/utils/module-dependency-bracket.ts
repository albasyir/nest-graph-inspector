/**
 * One module among the others, laid out as a tournament bracket that opens
 * both ways: what it needs to its left, what needs it to its right.
 *
 * The navigator answers "how do all the modules fit together"; this answers
 * it for one module at a time. The module sits in the middle. The modules it
 * imports stand one column to its left, the modules those import one column
 * further, and so on — and the modules importing it fan out to its right the
 * same way. Each side is a breadth-first walk of the imports, one way or the
 * other, so a module stands once per side, at its shortest distance, however
 * many ways lead to it; a cycle can never make a walk go round for ever. A
 * module that stands on both sides is on a cycle with the one in the middle —
 * it needs it and is needed by it — and says so.
 *
 * Each side shows as many levels as it is asked for, and the two are asked for
 * separately. A branch that goes on past the last level drawn ends in a stub
 * counting the modules waiting one level further along it.
 *
 * Every import is drawn from the module imported to the module importing it,
 * as the navigator draws an import, so arrows run left to right across the
 * whole bracket: into the middle from what it needs, out of it to what needs
 * it. The breadth-first tree of each side is drawn solid, as bracket
 * connectors; an import between two modules already drawn on the same side is
 * drawn as a dashed link instead of standing a module twice. An import back
 * into the middle is the one never drawn again on its side: the module making
 * it always stands one level into the other side, joined to the middle there.
 * An import on a cycle the graph reports carries that cycle's `#id`.
 *
 * Pure data in, pure data out — the component only renders what this returns,
 * and the layout is the same for the same graph every time.
 */
import type { GraphOutput, GraphOutputModule } from 'nest-graph-inspector'
import {
  formatCircularEdgeLabel,
  getCircularEdgeGeometry,
  getCircularLabelBox,
  unionRects,
  type CircularEdgeRect,
  type CircularEdgeSide,
  type CircularLabelSpot
} from './circular-dependency-edge.ts'
import { getDirectRunNodeId } from './direct-run-provider.ts'
import { roundedPolylinePath, type EdgePoint } from './graph-viewer-edges.ts'
import { encodeModuleId } from './module-id.ts'

/**
 * A side of the bracket: `left` holds what the module in the middle needs —
 * its imports, theirs, and so on — and `right` what needs it.
 */
export type BracketSide = 'left' | 'right'

export const BRACKET_SIDES: readonly BracketSide[] = ['left', 'right']

/** How many levels a side shows when nothing else is asked for. */
export const DEFAULT_BRACKET_DEPTH = 3

export type ModuleDependencyBracketInput = {
  graph: Pick<GraphOutput, 'modules'> & Partial<Pick<GraphOutput, 'root' | 'cycles'>>
  /** The module in the middle. */
  center: string
  /**
   * How many levels each side is asked to show. Anything under 1, or not a
   * whole number, is read as the nearest depth there is; a side with fewer
   * levels shows all it has.
   */
  depth: Readonly<Record<BracketSide, number>>
}

/** Where a node is drawn, in flow coordinates, and its size. */
type NodeBox = {
  id: string
  position: EdgePoint
  width: number
  height: number
}

/** What the card in the middle says about its module. */
export type BracketCenterStats = {
  providers: number
  controllers: number
  imports: number
  exports: number
  /**
   * Node ids of the providers, then the controllers, of the module that
   * advertise a method Direct Run can call, in the order the module declares
   * them.
   */
  runnableNodeIds: string[]
}

export type BracketCenterNode = NodeBox & {
  kind: 'center'
  moduleName: string
  isRoot: boolean
  /** The module is on a cycle: some module stands on both sides, or it imports itself. */
  isOnCycle: boolean
  stats: BracketCenterStats
}

export type BracketModuleNode = NodeBox & {
  kind: 'module'
  moduleName: string
  side: BracketSide
  /** How many imports away from the middle: 1 for the module's own. */
  level: number
  isRoot: boolean
  /**
   * The module stands on both sides — it needs the module in the middle and
   * is needed by it — so the two are on a cycle. Read from every level, drawn
   * or not.
   */
  isOnCycleWithCenter: boolean
}

/** Where a branch goes on past the last level drawn. */
export type BracketStubNode = NodeBox & {
  kind: 'stub'
  side: BracketSide
  /** The level the modules it counts stand on, one past the last drawn. */
  level: number
  /** The node id of the module whose branch it ends. */
  parentId: string
  /** Distinct modules one level further along the branch, none of them drawn. */
  moduleCount: number
}

/** Stands in for a side with no module on it at all. */
export type BracketEmptyNode = NodeBox & {
  kind: 'empty'
  side: BracketSide
}

/** The heading over a column. */
export type BracketLevelNode = NodeBox & {
  kind: 'level'
  side: BracketSide
  level: number
  /** Modules in the column. */
  moduleCount: number
}

export type BracketNode
  = | BracketCenterNode
    | BracketModuleNode
    | BracketStubNode
    | BracketEmptyNode
    | BracketLevelNode

/** A handle every bracket node has: one of each kind on each side. */
export type BracketHandle = 'left-source' | 'left-target' | 'right-source' | 'right-target'

/**
 * What an edge draws: an import on a side's breadth-first tree (`tree`), an
 * import between two modules already drawn on that side (`link`), a branch
 * running on into its stub (`stub`), or a module importing itself (`self`).
 */
export type BracketEdgeKind = 'tree' | 'link' | 'stub' | 'self'

export type BracketEdge = {
  id: string
  /** The module imported — or, for a stub edge, the end of the branch. */
  source: string
  /** The module importing it — or, for a stub edge, the stub. */
  target: string
  sourceHandle: BracketHandle
  targetHandle: BracketHandle
  kind: BracketEdgeKind
  /** The side it is drawn on; `null` for the module in the middle importing itself. */
  side: BracketSide | null
  /**
   * The ids of the module cycles the graph reports that this import is a
   * step of, ascending; empty for an import on none, and for a stub edge.
   */
  cycleIds: number[]
  /** SVG path data the edge is drawn along, in flow coordinates. */
  path: string
  /** Where its `#id` label goes, for an edge on a reported cycle; `null` otherwise. */
  label: CircularLabelSpot | null
}

export type BracketSideSummary = {
  /** The depth asked for, read as a whole number of at least 1. */
  requested: number
  /**
   * Levels drawn: the depth asked for, or every level the side has when it
   * has fewer; `0` for a side with no module on it.
   */
  depth: number
  /** Levels the side has, drawn or not. */
  available: number
  /** A level past the last one drawn exists. */
  hasMore: boolean
  /** Modules drawn on the side. */
  shown: number
  /** Modules on the side, drawn or not. */
  total: number
}

export type ModuleDependencyBracket = {
  center: string
  nodes: BracketNode[]
  edges: BracketEdge[]
  sides: Record<BracketSide, BracketSideSummary>
  /** Everything drawn, edges and their labels included: what a fit frames. */
  bounds: CircularEdgeRect
}

export const BRACKET_CENTER_WIDTH = 296
export const BRACKET_CENTER_HEIGHT = 156
export const BRACKET_MODULE_WIDTH = 216
export const BRACKET_MODULE_HEIGHT = 40
export const BRACKET_STUB_WIDTH = 136
const STUB_HEIGHT = BRACKET_MODULE_HEIGHT
const EMPTY_WIDTH = BRACKET_MODULE_WIDTH
const EMPTY_HEIGHT = 64
const LEVEL_LABEL_HEIGHT = 24
/** Between the top of the tallest column and the column headings. */
const LEVEL_LABEL_GAP = 20
/**
 * Between two columns: room for the bracket's connectors, which turn halfway
 * across, for the dashed links' lanes either side of that, and for a cycle
 * label on a connector's own stretch.
 */
const COLUMN_GAP = 128
/** Between the rows a column's modules stand on. */
const ROW_PITCH = BRACKET_MODULE_HEIGHT + 16
/** How far out of its column a link's first lane runs, and how far apart lanes are. */
const LANE_START = 16
const LANE_STEP = 8
/** Lanes in a gap before they start over: they stay clear of its middle. */
const LANE_COUNT = 5
/** How round an edge's corners are. */
const CORNER_RADIUS = 8
/** How far along its own stretch of connector a tree edge's label sits. */
const TREE_LABEL_INSET = COLUMN_GAP / 4

const LABEL_CENTERED = {
  labelTransform: 'translate(-50%, -50%)',
  labelAnchor: { x: 0.5, y: 0.5 }
} as const

/** The node id of the module in the middle. */
export const BRACKET_CENTER_ID = 'center'

/**
 * The bracket around `input.center`, or `null` when the graph has no such
 * module.
 *
 * Every walk, layout and route here is linear in the modules and imports the
 * graph holds, give or take the sorting of a column, so a graph of hundreds of
 * modules lays out in a few milliseconds.
 */
export function buildModuleDependencyBracket(
  input: ModuleDependencyBracketInput
): ModuleDependencyBracket | null {
  const { graph, center } = input
  const centerModule = Object.hasOwn(graph.modules, center)
    ? graph.modules[center]
    : undefined
  if (!centerModule) {
    return null
  }

  const adjacency = buildAdjacency(graph.modules)
  const walks: Record<BracketSide, SideWalk> = {
    left: walkSide(adjacency.left, center),
    right: walkSide(adjacency.right, center)
  }
  const isOnBothSides = (moduleName: string) =>
    moduleName !== center
    && walks.left.distance.has(moduleName)
    && walks.right.distance.has(moduleName)
  const importsItself = (adjacency.left.get(center) ?? []).includes(center)

  const centerNode: BracketCenterNode = {
    kind: 'center',
    id: BRACKET_CENTER_ID,
    moduleName: center,
    position: { x: -BRACKET_CENTER_WIDTH / 2, y: -BRACKET_CENTER_HEIGHT / 2 },
    width: BRACKET_CENTER_WIDTH,
    height: BRACKET_CENTER_HEIGHT,
    isRoot: graph.root === center,
    isOnCycle: importsItself || [...walks.left.distance.keys()].some(isOnBothSides),
    stats: getCenterStats(center, centerModule)
  }

  const buildSide = (side: BracketSide) => {
    const walk = walks[side]
    const requested = readDepth(input.depth[side])
    const depth = Math.min(requested, walk.deepest)
    const layout = layoutSide({
      side,
      center,
      walk,
      depth,
      neighbours: adjacency[side],
      parentsOf: adjacency[otherSide(side)],
      isRoot: moduleName => graph.root === moduleName,
      isOnBothSides
    })
    const summary: BracketSideSummary = {
      requested,
      depth,
      available: walk.deepest,
      hasMore: walk.deepest > depth,
      shown: layout.modules.size,
      total: walk.distance.size - 1
    }

    return { layout, summary }
  }

  const left = buildSide('left')
  const right = buildSide('right')
  const layouts: Record<BracketSide, SideLayout> = { left: left.layout, right: right.layout }

  const nodes: BracketNode[] = [centerNode, ...left.layout.nodes, ...right.layout.nodes]
  nodes.push(...getLevelLabels(nodes, layouts))

  const routePoints: EdgePoint[] = []
  const edges = routeEdges({
    center: centerNode,
    importsItself,
    layouts,
    walks,
    adjacency,
    cycleIdsByImport: indexModuleCycles(graph.cycles?.modules),
    routePoints
  })

  return {
    center,
    nodes,
    edges,
    sides: { left: left.summary, right: right.summary },
    bounds: getBracketBounds(nodes, edges, routePoints)
  }
}

/**
 * The node id of a module drawn on a side. The name goes through
 * `encodeModuleId`, which escapes the `:` it is joined with, so no two modules
 * — on one side or across both — ever share an id.
 */
export function getBracketModuleNodeId(side: BracketSide, moduleName: string): string {
  return `${side}:${encodeModuleId(moduleName)}`
}

function getStubNodeId(side: BracketSide, moduleName: string): string {
  return `stub-${side}:${encodeModuleId(moduleName)}`
}

function otherSide(side: BracketSide): BracketSide {
  return side === 'left' ? 'right' : 'left'
}

function readDepth(depth: number): number {
  return Number.isFinite(depth) ? Math.max(1, Math.floor(depth)) : DEFAULT_BRACKET_DEPTH
}

/** Who imports whom, both ways: each list in the graph's own order, without repeats. */
type Adjacency = Record<BracketSide, ReadonlyMap<string, readonly string[]>>

/**
 * Each module's imports (`left`, what it needs) and the modules importing it
 * (`right`, what needs it). An import naming a module the graph does not
 * describe goes nowhere it could be drawn, and is left out; one listed twice
 * counts once.
 */
function buildAdjacency(modules: GraphOutput['modules']): Adjacency {
  const imports = new Map<string, string[]>()
  const dependents = new Map<string, string[]>()

  for (const moduleName of Object.keys(modules)) {
    imports.set(moduleName, [])
    dependents.set(moduleName, [])
  }

  for (const [moduleName, mod] of Object.entries(modules)) {
    const own = imports.get(moduleName) ?? []
    for (const imported of mod.imports) {
      const importers = dependents.get(imported)
      if (!importers || own.includes(imported)) {
        continue
      }

      own.push(imported)
      importers.push(moduleName)
    }
  }

  return { left: imports, right: dependents }
}

/** One side's breadth-first walk from the module in the middle. */
type SideWalk = {
  /** Each module the walk reached, with how many steps it took; the middle is 0. */
  distance: Map<string, number>
  /** The module each one was first reached from: its parent on the side's tree. */
  parent: Map<string, string>
  /** The furthest any module stands; 0 for a side with none. */
  deepest: number
}

/**
 * The breadth-first walk of one side. A module is reached once, at its
 * shortest distance, so a cycle — or a module importing itself — only ever
 * leads back to a module already reached, and the walk ends.
 */
function walkSide(
  neighbours: ReadonlyMap<string, readonly string[]>,
  center: string
): SideWalk {
  const distance = new Map<string, number>([[center, 0]])
  const parent = new Map<string, string>()
  const queue = [center]
  let deepest = 0

  // An array iterator reads the length afresh each step, so the modules
  // queued as it goes are walked too.
  for (const moduleName of queue) {
    const nextDistance = (distance.get(moduleName) ?? 0) + 1

    for (const next of neighbours.get(moduleName) ?? []) {
      if (distance.has(next)) {
        continue
      }

      distance.set(next, nextDistance)
      parent.set(next, moduleName)
      deepest = nextDistance
      queue.push(next)
    }
  }

  return { distance, parent, deepest }
}

/** A side laid out: its nodes, and the module nodes by module name. */
type SideLayout = {
  depth: number
  nodes: Array<BracketModuleNode | BracketStubNode | BracketEmptyNode>
  modules: Map<string, BracketModuleNode>
  /** Each stub, with the module whose branch it ends. */
  stubs: Array<{ stub: BracketStubNode, branch: BracketModuleNode }>
}

/**
 * Lays one side out as a bracket: each module in the column of its level, and
 * — as in a tournament bracket — each one nearer the middle placed halfway
 * down the rows its own branch takes, so no branch crosses another. Siblings
 * are ordered by where all their parents on the side stand in the column
 * before — every module there importing them on the left, or imported by them
 * on the right, not only the one the walk came from — which keeps the dashed
 * links between branches short; the first column, whose one parent is the
 * middle, is in name order.
 */
function layoutSide(params: {
  side: BracketSide
  center: string
  walk: SideWalk
  depth: number
  neighbours: ReadonlyMap<string, readonly string[]>
  /** Each module's neighbours the other way: its parents on this side. */
  parentsOf: ReadonlyMap<string, readonly string[]>
  isRoot: (moduleName: string) => boolean
  isOnBothSides: (moduleName: string) => boolean
}): SideLayout {
  const { side, center, walk, depth, neighbours, parentsOf } = params
  const layout: SideLayout = { depth, nodes: [], modules: new Map(), stubs: [] }
  const direction = side === 'left' ? -1 : 1

  if (depth === 0) {
    layout.nodes.push({
      kind: 'empty',
      id: `empty-${side}`,
      side,
      position: { x: getColumnX(direction, EMPTY_WIDTH), y: -EMPTY_HEIGHT / 2 },
      width: EMPTY_WIDTH,
      height: EMPTY_HEIGHT
    })
    return layout
  }

  // The side's tree, as far as it is drawn.
  const children = new Map<string, string[]>()
  for (const [moduleName, steps] of walk.distance) {
    const parent = walk.parent.get(moduleName)
    if (parent === undefined || steps > depth) {
      continue
    }

    const siblings = children.get(parent) ?? []
    siblings.push(moduleName)
    children.set(parent, siblings)
  }

  // Each column top to bottom: every parent's children together, in the order
  // their parents stand, and among themselves by where their parents stand.
  const columns: string[][] = []
  let previous = [center]
  for (let level = 1; level <= depth; level += 1) {
    const indexInPrevious = new Map(previous.map((moduleName, index) => [moduleName, index]))
    const column: string[] = []

    for (const parent of previous) {
      const ordered = (children.get(parent) ?? [])
        .map(moduleName => ({
          moduleName,
          key: level === 1 ? 0 : getBarycenter(parentsOf.get(moduleName) ?? [], indexInPrevious)
        }))
        .sort((left, right) =>
          left.key - right.key || compareText(left.moduleName, right.moduleName)
        )
        .map(entry => entry.moduleName)

      children.set(parent, ordered)
      column.push(...ordered)
    }

    columns.push(column)
    previous = column
  }

  // How many rows each branch takes: a module on the last level drawn takes
  // one, the stub ending its branch standing beside it on the same row.
  const rows = new Map<string, number>()
  for (let level = depth; level >= 1; level -= 1) {
    for (const moduleName of columns[level - 1] ?? []) {
      const branchRows = (children.get(moduleName) ?? [])
        .reduce((total, child) => total + (rows.get(child) ?? 1), 0)
      rows.set(moduleName, Math.max(1, branchRows))
    }
  }

  // Rows top-down: each module halfway down the rows its branch takes, and the
  // whole side centred on the middle.
  const rowCenter = new Map<string, number>()
  const place = (moduleName: string, firstRow: number) => {
    rowCenter.set(moduleName, firstRow + (rows.get(moduleName) ?? 1) / 2)

    let row = firstRow
    for (const child of children.get(moduleName) ?? []) {
      place(child, row)
      row += rows.get(child) ?? 1
    }
  }
  place(center, -sumRows(columns[0] ?? [], rows) / 2)

  for (const [index, column] of columns.entries()) {
    const level = index + 1
    for (const moduleName of column) {
      const node: BracketModuleNode = {
        kind: 'module',
        id: getBracketModuleNodeId(side, moduleName),
        moduleName,
        side,
        level,
        position: {
          x: getColumnX(direction * level, BRACKET_MODULE_WIDTH),
          y: (rowCenter.get(moduleName) ?? 0) * ROW_PITCH - BRACKET_MODULE_HEIGHT / 2
        },
        width: BRACKET_MODULE_WIDTH,
        height: BRACKET_MODULE_HEIGHT,
        isRoot: params.isRoot(moduleName),
        isOnCycleWithCenter: params.isOnBothSides(moduleName)
      }
      layout.nodes.push(node)
      layout.modules.set(moduleName, node)
    }
  }

  // A branch that goes on past the last level drawn ends in a stub counting
  // the distinct modules one level further along it.
  for (const moduleName of columns[depth - 1] ?? []) {
    const branch = layout.modules.get(moduleName)
    const moduleCount = (neighbours.get(moduleName) ?? [])
      .filter(next => walk.distance.get(next) === depth + 1)
      .length
    if (!branch || moduleCount === 0) {
      continue
    }

    const stub: BracketStubNode = {
      kind: 'stub',
      id: getStubNodeId(side, moduleName),
      side,
      level: depth + 1,
      parentId: branch.id,
      moduleCount,
      position: {
        x: getColumnX(direction * (depth + 1), BRACKET_STUB_WIDTH),
        y: branch.position.y + (BRACKET_MODULE_HEIGHT - STUB_HEIGHT) / 2
      },
      width: BRACKET_STUB_WIDTH,
      height: STUB_HEIGHT
    }
    layout.nodes.push(stub)
    layout.stubs.push({ stub, branch })
  }

  return layout
}

function sumRows(moduleNames: readonly string[], rows: ReadonlyMap<string, number>): number {
  return moduleNames.reduce((total, moduleName) => total + (rows.get(moduleName) ?? 1), 0)
}

/**
 * Where a module's parents stand in the column before, on average — its key
 * for its place among its siblings. Only parents in that column count; its
 * parent on the tree always is one.
 */
function getBarycenter(
  parents: readonly string[],
  indexInPrevious: ReadonlyMap<string, number>
): number {
  let sum = 0
  let count = 0
  for (const parent of parents) {
    const index = indexInPrevious.get(parent)
    if (index !== undefined) {
      sum += index
      count += 1
    }
  }

  return count > 0 ? sum / count : Number.POSITIVE_INFINITY
}

/**
 * The x of a node `width` wide in `column`: 0 is the middle, negative columns
 * run left and positive ones right. A node narrower than a column — a stub —
 * keeps to the column's side nearer the middle, beside the branch it ends.
 */
function getColumnX(column: number, width: number): number {
  if (column === 0) {
    return -BRACKET_CENTER_WIDTH / 2
  }

  const reach = BRACKET_CENTER_WIDTH / 2
    + COLUMN_GAP
    + (Math.abs(column) - 1) * (BRACKET_MODULE_WIDTH + COLUMN_GAP)

  return column > 0 ? reach : -reach - width
}

/** Every column drawn gets a heading, level with the others above the tallest column. */
function getLevelLabels(
  nodes: readonly BracketNode[],
  layouts: Readonly<Record<BracketSide, SideLayout>>
): BracketLevelNode[] {
  const top = Math.min(...nodes.map(node => node.position.y))
  const labels: BracketLevelNode[] = []

  for (const side of BRACKET_SIDES) {
    const { depth, modules } = layouts[side]
    const counts = new Map<number, number>()
    for (const node of modules.values()) {
      counts.set(node.level, (counts.get(node.level) ?? 0) + 1)
    }

    for (let level = 1; level <= depth; level += 1) {
      labels.push({
        kind: 'level',
        id: `level-${side}-${level}`,
        side,
        level,
        moduleCount: counts.get(level) ?? 0,
        position: {
          x: getColumnX(side === 'left' ? -level : level, BRACKET_MODULE_WIDTH),
          y: top - LEVEL_LABEL_GAP - LEVEL_LABEL_HEIGHT
        },
        width: BRACKET_MODULE_WIDTH,
        height: LEVEL_LABEL_HEIGHT
      })
    }
  }

  return labels
}

/** The facts the card in the middle shows, read from the module itself. */
function getCenterStats(moduleName: string, mod: GraphOutputModule): BracketCenterStats {
  return {
    providers: mod.providers.length,
    controllers: mod.controllers.length,
    imports: mod.imports.length,
    exports: mod.exports.length,
    runnableNodeIds: [
      ...mod.providers
        .filter(provider => (provider.directRun?.methods.length ?? 0) > 0)
        .map(provider => getDirectRunNodeId('provider', moduleName, provider.name)),
      ...mod.controllers
        .filter(controller => (controller.directRun?.methods.length ?? 0) > 0)
        .map(controller => getDirectRunNodeId('controller', moduleName, controller.name))
    ]
  }
}

/** One import as a key: who imports, then what. JSON, so no name runs into another. */
function getImportKey(importer: string, imported: string): string {
  return JSON.stringify([importer, imported])
}

/**
 * Each import the graph's module cycles run through, with the cycles it is a
 * step of. A cycle's path names each module in import order, the last
 * repeating the first, so each module imports the next.
 */
function indexModuleCycles(
  cycles: GraphOutput['cycles']['modules'] | undefined
): Map<string, number[]> {
  const byImport = new Map<string, number[]>()

  for (const cycle of cycles ?? []) {
    for (let index = 0; index < cycle.path.length - 1; index += 1) {
      const importer = cycle.path[index]
      const imported = cycle.path[index + 1]
      if (importer === undefined || imported === undefined) {
        continue
      }

      const key = getImportKey(importer, imported)
      const ids = byImport.get(key) ?? []
      if (!ids.includes(cycle.id)) {
        ids.push(cycle.id)
      }
      byImport.set(key, ids)
    }
  }

  for (const ids of byImport.values()) {
    ids.sort((left, right) => left - right)
  }

  return byImport
}

/**
 * Every edge of the bracket, routed.
 *
 * Each import is drawn once per side it shows on. On the left a module's
 * imports are the side's next level; on the right the modules importing it
 * are. The walk's first way to a module is its tree edge, any other import
 * between two modules drawn on that side a dashed link, and an import back
 * into the middle is left to the other side, where the module making it
 * stands one level in, joined to the middle by its tree edge.
 */
function routeEdges(params: {
  center: BracketCenterNode
  importsItself: boolean
  layouts: Readonly<Record<BracketSide, SideLayout>>
  walks: Readonly<Record<BracketSide, SideWalk>>
  adjacency: Adjacency
  cycleIdsByImport: ReadonlyMap<string, number[]>
  /** Collects every point a route turns at or passes, for the bounds. */
  routePoints: EdgePoint[]
}): BracketEdge[] {
  const { center, layouts, walks, adjacency, cycleIdsByImport } = params
  const router = createRouter(params.routePoints)
  const edges: BracketEdge[] = []
  const cycleIdsOf = (importer: string, imported: string) =>
    [...(cycleIdsByImport.get(getImportKey(importer, imported)) ?? [])]

  if (params.importsItself) {
    edges.push(router.selfLoop(center, null, cycleIdsOf(center.moduleName, center.moduleName)))
  }

  for (const side of BRACKET_SIDES) {
    const { modules, stubs } = layouts[side]
    const walk = walks[side]

    for (const node of modules.values()) {
      const parentName = walk.parent.get(node.moduleName)
      const parent = parentName === center.moduleName
        ? center
        : modules.get(parentName ?? '')
      if (!parent) {
        continue
      }

      // On the left the parent imports the module; on the right the module
      // imports its parent.
      edges.push(side === 'left'
        ? router.route({
            kind: 'tree',
            side,
            source: node,
            target: parent,
            cycleIds: cycleIdsOf(parent.moduleName, node.moduleName)
          })
        : router.route({
            kind: 'tree',
            side,
            source: parent,
            target: node,
            cycleIds: cycleIdsOf(node.moduleName, parent.moduleName)
          }))
    }

    for (const node of modules.values()) {
      for (const next of adjacency[side].get(node.moduleName) ?? []) {
        if (next === node.moduleName) {
          edges.push(router.selfLoop(node, side, cycleIdsOf(next, next)))
          continue
        }

        // The middle is never in `modules`: an import back into it is drawn on
        // the other side. A module not drawn here has no node to join.
        const other = modules.get(next)
        if (!other || walk.parent.get(next) === node.moduleName) {
          continue
        }

        edges.push(side === 'left'
          ? router.route({
              kind: 'link',
              side,
              source: other,
              target: node,
              cycleIds: cycleIdsOf(node.moduleName, next)
            })
          : router.route({
              kind: 'link',
              side,
              source: node,
              target: other,
              cycleIds: cycleIdsOf(next, node.moduleName)
            }))
      }
    }

    for (const { stub, branch } of stubs) {
      edges.push(side === 'left'
        ? router.route({ kind: 'stub', side, source: stub, target: branch, cycleIds: [] })
        : router.route({ kind: 'stub', side, source: branch, target: stub, cycleIds: [] }))
    }
  }

  return edges
}

type RoutedNode = BracketCenterNode | BracketModuleNode | BracketStubNode

/** A node's column: 0 for the middle, negative to its left. */
function getColumn(node: RoutedNode): number {
  if (node.kind === 'center') {
    return 0
  }

  return node.side === 'left' ? -node.level : node.level
}

/**
 * Routes edges across the bracket. Every edge leaves and enters a node by its
 * left or right side and turns only at right angles:
 *
 * - An edge into the next column out — every tree and stub edge, and any link
 *   between neighbouring columns — turns halfway across the gap, so the
 *   branches of one module share one upright, the way a bracket joins them.
 * - A link back towards the middle leaves its module by the side facing the
 *   middle, turns in a lane of its own in the gap beside the column it ends
 *   in, and comes into that column from its far side.
 * - A link within one column runs round the column's outer side, in a lane of
 *   its own.
 *
 * Lanes keep to either side of a gap's middle, where the brackets turn: links
 * within a column next to that column, links back towards the middle next to
 * the column on the gap's other side — so no lane runs along an upright.
 */
function createRouter(routePoints: EdgePoint[]) {
  const lanes = new Map<string, number>()
  const nextLane = (key: string) => {
    const lane = lanes.get(key) ?? 0
    lanes.set(key, lane + 1)
    return (lane % LANE_COUNT) * LANE_STEP + LANE_START
  }

  function route(params: {
    kind: Exclude<BracketEdgeKind, 'self'>
    side: BracketSide
    source: RoutedNode
    target: RoutedNode
    cycleIds: number[]
  }): BracketEdge {
    const { kind, side, source, target, cycleIds } = params
    const sourceColumn = getColumn(source)
    const targetColumn = getColumn(target)
    let points: EdgePoint[]
    let handles: readonly [BracketHandle, BracketHandle]
    let label: EdgePoint

    if (sourceColumn < targetColumn) {
      const from = rightOf(source)
      const to = leftOf(target)
      const turn = (from.x + to.x) / 2
      points = from.y === to.y
        ? [from, to]
        : [from, { x: turn, y: from.y }, { x: turn, y: to.y }, to]
      handles = ['right-source', 'left-target']
      // On the stretch only this edge runs along: beside the module further
      // out, before the branches of its parent join.
      label = side === 'left'
        ? { x: from.x + TREE_LABEL_INSET, y: from.y }
        : { x: to.x - TREE_LABEL_INSET, y: to.y }
    } else if (sourceColumn > targetColumn) {
      const from = leftOf(source)
      const to = rightOf(target)
      const offset = nextLane(`back:${side}:${targetColumn}`)
      const turn = side === 'left' ? to.x + offset : to.x + COLUMN_GAP - offset
      points = [from, { x: turn, y: from.y }, { x: turn, y: to.y }, to]
      handles = ['left-source', 'right-target']
      label = { x: turn, y: (from.y + to.y) / 2 }
    } else {
      const from = side === 'left' ? leftOf(source) : rightOf(source)
      const to = side === 'left' ? leftOf(target) : rightOf(target)
      const offset = nextLane(`same:${side}:${sourceColumn}`)
      const turn = side === 'left' ? from.x - offset : from.x + offset
      points = [from, { x: turn, y: from.y }, { x: turn, y: to.y }, to]
      handles = side === 'left'
        ? ['left-source', 'left-target']
        : ['right-source', 'right-target']
      label = { x: turn, y: (from.y + to.y) / 2 }
    }

    routePoints.push(...points)

    return {
      id: getEdgeId(kind, source.id, target.id),
      source: source.id,
      target: target.id,
      sourceHandle: handles[0],
      targetHandle: handles[1],
      kind,
      side,
      cycleIds,
      path: roundedPolylinePath(points, CORNER_RADIUS),
      label: cycleIds.length > 0 ? { labelX: label.x, labelY: label.y, ...LABEL_CENTERED } : null
    }
  }

  /**
   * A module importing itself: a loop out of its outer side — or, for the
   * module in the middle, out of its top, clear of both sides' brackets —
   * drawn as the module deep dive draws one.
   */
  function selfLoop(
    node: BracketCenterNode | BracketModuleNode,
    side: BracketSide | null,
    cycleIds: number[]
  ): BracketEdge {
    const loopSide: CircularEdgeSide = side ?? 'top'
    const anchor = loopSide === 'top'
      ? { x: node.position.x + node.width / 2, y: node.position.y }
      : loopSide === 'left' ? leftOf(node) : rightOf(node)
    const geometry = getCircularEdgeGeometry({
      sourceX: anchor.x,
      sourceY: anchor.y,
      sourcePosition: loopSide,
      targetX: anchor.x,
      targetY: anchor.y,
      targetPosition: loopSide,
      isSelfLoop: true
    })

    // A Bézier curve stays inside its control points.
    routePoints.push(...geometry.points)

    return {
      id: getEdgeId('self', node.id, node.id),
      source: node.id,
      target: node.id,
      sourceHandle: 'right-source',
      targetHandle: 'right-target',
      kind: 'self',
      side,
      cycleIds,
      path: geometry.path,
      label: cycleIds.length > 0
        ? {
            labelX: geometry.labelX,
            labelY: geometry.labelY,
            labelTransform: geometry.labelTransform,
            labelAnchor: geometry.labelAnchor
          }
        : null
    }
  }

  return { route, selfLoop }
}

function getEdgeId(kind: BracketEdgeKind, source: string, target: string): string {
  return `${kind}:${JSON.stringify([source, target])}`
}

function leftOf(node: NodeBox): EdgePoint {
  return { x: node.position.x, y: node.position.y + node.height / 2 }
}

function rightOf(node: NodeBox): EdgePoint {
  return { x: node.position.x + node.width, y: node.position.y + node.height / 2 }
}

/**
 * The box holding every node, every point an edge's route passes and every
 * cycle label, at the size a label is drawn on a canvas at its own scale.
 */
function getBracketBounds(
  nodes: readonly BracketNode[],
  edges: readonly BracketEdge[],
  routePoints: readonly EdgePoint[]
): CircularEdgeRect {
  const rects: CircularEdgeRect[] = [
    ...nodes.map(node => ({
      x: node.position.x,
      y: node.position.y,
      width: node.width,
      height: node.height
    })),
    ...routePoints.map(point => ({ x: point.x, y: point.y, width: 0, height: 0 }))
  ]

  for (const edge of edges) {
    if (edge.label) {
      rects.push(getCircularLabelBox(edge.label, formatCircularEdgeLabel(edge.cycleIds)))
    }
  }

  return unionRects(rects) ?? { x: 0, y: 0, width: 0, height: 0 }
}

/** Code-unit order, the same everywhere, unlike a locale's. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
