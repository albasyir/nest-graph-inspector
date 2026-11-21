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

const BRACKET_CENTER_WIDTH = 320
const BRACKET_CENTER_HEIGHT = 156
const BRACKET_MODULE_WIDTH = 244
const BRACKET_MODULE_HEIGHT = 40
const BRACKET_STUB_WIDTH = 136
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
/** Lanes beside a column: they stay clear of the gap's middle, where the brackets turn. */
const LANE_COUNT = 5
/** How far apart two links turning in one lane keep: a corner's radius each. */
const LANE_CLEARANCE = 8
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
 * The walks and the order of each column are linear in the modules and
 * imports the graph holds, give or take the sorting of a column; routing an
 * edge looks at the lanes beside its columns and, for a link reaching back
 * past the next column, at the gaps between the rows it crosses — so a graph
 * of hundreds of modules still lays out within a frame (the tests time 300).
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
    nodes,
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
 * Every edge of the bracket, routed and labelled.
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
  /** Every node drawn, which a link's label must not cover. */
  nodes: readonly BracketNode[]
  /** Collects every point a route turns at or passes, for the bounds. */
  routePoints: EdgePoint[]
}): BracketEdge[] {
  const { center, layouts, walks, adjacency, cycleIdsByImport } = params
  const cardsByColumn = new Map<number, CircularEdgeRect[]>()
  for (const node of params.nodes) {
    if (node.kind === 'module' || node.kind === 'stub') {
      const column = getColumn(node)
      const cards = cardsByColumn.get(column) ?? []
      cards.push({ x: node.position.x, y: node.position.y, width: node.width, height: node.height })
      cardsByColumn.set(column, cards)
    }
  }
  const router = createRouter(params.routePoints, cardsByColumn)
  const edges: RoutedEdge[] = []
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

  return labelEdges(edges, params.nodes)
}

/**
 * Labels every edge on a reported cycle with its `#ids`.
 *
 * A tree edge's label goes where it settled while routing: on the stretch
 * beside the module further out, which only that edge runs along. A loop's
 * goes beside the loop. A dashed link turns in a lane beside other lanes and
 * close to a column of cards, so its label is placed after those: on its own
 * upright, reaching from it into the open gap — away from the cards the lane
 * hugs — at the first height, from the middle out, where it covers no card and
 * no label placed before it.
 */
function labelEdges(routed: readonly RoutedEdge[], nodes: readonly BracketNode[]): BracketEdge[] {
  const taken: CircularEdgeRect[] = nodes.map(node => ({
    x: node.position.x,
    y: node.position.y,
    width: node.width,
    height: node.height
  }))

  for (const { edge, label } of routed) {
    if (edge.cycleIds.length > 0 && label) {
      edge.label = label
      taken.push(getCircularLabelBox(label, formatCircularEdgeLabel(edge.cycleIds)))
    }
  }

  for (const { edge, lane, points } of routed) {
    if (edge.cycleIds.length === 0 || !lane) {
      continue
    }

    const text = formatCircularEdgeLabel(edge.cycleIds)
    edge.label = placeLaneLabel({ lane, route: points, text, taken })
    taken.push(getCircularLabelBox(edge.label, text))
  }

  return routed.map(({ edge }) => edge)
}

type RoutedNode = BracketCenterNode | BracketModuleNode | BracketStubNode

/**
 * An edge as the router leaves it: the points its route runs through, and
 * where its label goes — settled already, for a route with a stretch only it
 * runs along, or to be placed along its `lane`.
 */
type RoutedEdge = {
  edge: BracketEdge
  points: EdgePoint[]
  label: CircularLabelSpot | null
  lane: LabelLane | null
}

/**
 * A link's upright: where along it a label may sit, and which way the label
 * reaches from it — away from the cards the lane runs beside, or both ways
 * from an upright halfway across a gap.
 */
type LabelLane = {
  x: number
  top: number
  bottom: number
  reach: 'left' | 'right' | 'both'
}

/** Between a label and the lane it reaches from, and around a label it must clear. */
const LANE_LABEL_GAP = 3
const LANE_LABEL_CLEARANCE = 3
/** How far apart the heights a label is tried at along its lane are. */
const LANE_LABEL_STEP = 6

/**
 * A link's label: beside its lane, reaching away from the cards the lane
 * hugs, at the first height from the lane's middle out that is clear; else
 * centred on the first clear spot along the rest of its route — a lane with
 * both ends on one row has no height to offer — longest stretch first, each
 * from its middle out; else at the lane's middle, covering what it must.
 */
function placeLaneLabel(params: {
  lane: LabelLane
  route: readonly EdgePoint[]
  text: string
  taken: readonly CircularEdgeRect[]
}): CircularLabelSpot {
  const { lane, route, text, taken } = params
  const spotAt = (y: number): CircularLabelSpot => {
    switch (lane.reach) {
      case 'left':
        return {
          labelX: lane.x - LANE_LABEL_GAP,
          labelY: y,
          labelTransform: 'translate(-100%, -50%)',
          labelAnchor: { x: 1, y: 0.5 }
        }
      case 'right':
        return {
          labelX: lane.x + LANE_LABEL_GAP,
          labelY: y,
          labelTransform: 'translate(0, -50%)',
          labelAnchor: { x: 0, y: 0.5 }
        }
      case 'both':
        return { labelX: lane.x, labelY: y, ...LABEL_CENTERED }
      default: {
        const _exhaustive: never = lane.reach
        return _exhaustive
      }
    }
  }

  const middle = (lane.top + lane.bottom) / 2
  const heights = [middle]
  for (let step = LANE_LABEL_STEP; middle - step >= lane.top; step += LANE_LABEL_STEP) {
    heights.push(middle - step, middle + step)
  }

  const candidates = [
    ...heights.map(spotAt),
    ...getStretchSpots(route).map(point => ({ labelX: point.x, labelY: point.y, ...LABEL_CENTERED }))
  ]
  for (const spot of candidates) {
    const box = grow(getCircularLabelBox(spot, text), LANE_LABEL_CLEARANCE)
    if (!taken.some(other => boxesOverlap(box, other))) {
      return spot
    }
  }

  return spotAt(middle)
}

/** Points along a route a label may be centred on: longest stretch first, each from its middle out. */
function getStretchSpots(route: readonly EdgePoint[]): EdgePoint[] {
  const stretches = route
    .slice(1)
    .map((end, index) => {
      const start = route[index] ?? end
      return { start, end, length: Math.hypot(end.x - start.x, end.y - start.y) }
    })
    .filter(stretch => stretch.length > 0)
    .sort((left, right) => right.length - left.length)

  return stretches.flatMap(({ start, end, length }) => {
    const offsets = [0]
    for (let offset = LANE_LABEL_STEP; offset <= length / 2; offset += LANE_LABEL_STEP) {
      offsets.push(offset, -offset)
    }

    return offsets.map((offset) => {
      const t = 0.5 + offset / length
      return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }
    })
  })
}

/** Half the gap between two rows of cards: where a channel between them runs. */
const HALF_ROW_GAP = (ROW_PITCH - BRACKET_MODULE_HEIGHT) / 2
/** How far a channel keeps from the cards it runs between. */
const CHANNEL_CLEARANCE = 2
/** How far apart two links crossing in one gap between rows run. */
const CHANNEL_STEP = 4
/** Where in a gap a link may cross: its middle first, then a step to either side. */
const CHANNEL_SHIFTS = [0, -CHANNEL_STEP, CHANNEL_STEP] as const
/**
 * What running a step off a gap's middle costs, in detour: more than the
 * step saves, so a link takes the middle of a free gap whenever one is near.
 */
const CHANNEL_SHIFT_COST = CHANNEL_STEP * 2 + 1
/** The longest way round a link takes to keep off another link's crossing. */
const CHANNEL_DETOUR_LIMIT = ROW_PITCH * 4

/** Where a link reaching back past the next column crosses the columns between. */
type Crossing = { y: number, left: number, right: number }

/**
 * A run of columns a link crosses, as a channel through them is looked for:
 * the heights their cards block, clearance included — open spans, top to
 * bottom, merged where they overlap, so whether a height is clear of every
 * card is one binary search — and the middles of the gaps above and below
 * each card, once each, since cards level across the columns share them.
 */
type CrossedColumns = {
  blocked: ReadonlyArray<readonly [number, number]>
  gapMiddles: readonly number[]
}

function getCrossedColumns(cards: readonly CircularEdgeRect[]): CrossedColumns {
  const spans = cards
    .map((card): [number, number] => [card.y - CHANNEL_CLEARANCE, card.y + card.height + CHANNEL_CLEARANCE])
    .sort((above, below) => above[0] - below[0])
  const blocked: Array<[number, number]> = []

  for (const span of spans) {
    const last = blocked.at(-1)
    // Open spans that only touch leave the height they touch at clear.
    if (last && span[0] < last[1]) {
      last[1] = Math.max(last[1], span[1])
    } else {
      blocked.push(span)
    }
  }

  const gapMiddles = new Set<number>()
  for (const card of cards) {
    gapMiddles.add(card.y - HALF_ROW_GAP)
    gapMiddles.add(card.y + card.height + HALF_ROW_GAP)
  }

  return { blocked, gapMiddles: [...gapMiddles] }
}

/**
 * The height a link crosses `columns` at, between `left` and `right`, without
 * passing behind any of their cards: the height it is going at when that is
 * free — anywhere between its two ends costs the same length — else the free
 * channel nearest it, halfway between two rows, above the top row or below
 * the bottom one. It keeps off the heights other links already cross at, and
 * the `stubs` other edges leave the columns at its two ends by, moving to
 * another gap or a step to one side of the middle of this one; only when that
 * would take it far out of its way does it share the nearest channel. Above
 * the topmost card is always free, so there is always one.
 */
function findChannel(params: {
  columns: CrossedColumns
  crossings: readonly Crossing[]
  /**
   * The heights edges leave the columns at the link's two ends by, each
   * column's in ascending order, but for the height of the link's own card.
   */
  stubs: ReadonlyArray<{ heights: readonly number[], own: number }>
  fromY: number
  toY: number
  left: number
  right: number
}): number {
  const { columns: { blocked, gapMiddles }, crossings, stubs, fromY, toY, left, right } = params
  const isClearOfCards = (y: number) => {
    let low = 0
    let high = blocked.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      const span = blocked[middle]
      if (!span) {
        return true
      }
      if (y <= span[0]) {
        high = middle - 1
      } else if (y >= span[1]) {
        low = middle + 1
      } else {
        return false
      }
    }
    return true
  }
  const nearby = crossings.filter(crossing => crossing.left < right && crossing.right > left)
  const isClearOfLinks = (y: number) =>
    !stubs.some(stub => hasValueNear(stub.heights, y, CHANNEL_STEP, stub.own))
    && !nearby.some(crossing => Math.abs(crossing.y - y) < CHANNEL_STEP)

  let nearest: { y: number, cost: number } | null = null
  let nearestFree: { y: number, cost: number } | null = null
  const isBetter = (y: number, cost: number, than: { y: number, cost: number } | null) =>
    !than
    || cost < than.cost
    || (cost === than.cost && Math.abs(y - fromY) < Math.abs(than.y - fromY))

  for (const middle of [fromY, toY, ...gapMiddles]) {
    for (const shift of CHANNEL_SHIFTS) {
      const y = middle + shift
      if (!isClearOfCards(y)) {
        continue
      }

      const cost = (shift === 0 ? 0 : CHANNEL_SHIFT_COST) + Math.abs(y - fromY) + Math.abs(y - toY)
      if (isBetter(y, cost, nearest)) {
        nearest = { y, cost }
      }
      if (isBetter(y, cost, nearestFree) && isClearOfLinks(y)) {
        nearestFree = { y, cost }
      }
    }
  }

  if (nearestFree && nearest && nearestFree.cost <= nearest.cost + CHANNEL_DETOUR_LIMIT) {
    return nearestFree.y
  }
  return nearest?.y ?? fromY
}

/**
 * Whether any value of `sorted`, in ascending order, lies less than `distance`
 * from `y` — other than `except`.
 */
function hasValueNear(sorted: readonly number[], y: number, distance: number, except: number): boolean {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if ((sorted[middle] ?? Number.POSITIVE_INFINITY) <= y - distance) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  for (let index = low; index < sorted.length; index += 1) {
    const value = sorted[index] ?? Number.POSITIVE_INFINITY
    if (value >= y + distance) {
      return false
    }
    if (value !== except) {
      return true
    }
  }
  return false
}

function grow(rect: CircularEdgeRect, by: number): CircularEdgeRect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + by * 2, height: rect.height + by * 2 }
}

/** Whether two boxes share any area: touching edges do not count. */
function boxesOverlap(left: CircularEdgeRect, right: CircularEdgeRect): boolean {
  return left.x < right.x + right.width
    && right.x < left.x + left.width
    && left.y < right.y + right.height
    && right.y < left.y + left.height
}

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
 * - A tree or stub edge into the next column out turns halfway across the
 *   gap, so the branches of one module share one upright, the way a bracket
 *   joins them.
 * - A link into the next column out turns in a lane beside that column
 *   instead — halfway across it would run along another module's upright —
 *   and crosses the gap level with the module nearer the middle, where only
 *   that module's own branches run.
 * - A link back towards the middle leaves its module by the side facing the
 *   middle, turns in a lane of its own in the gap beside the column it ends
 *   in, and comes into that column from its far side. One reaching back past
 *   the next column first turns beside its own and crosses the columns
 *   between in a free channel between their rows (`findChannel`), so it never
 *   passes behind their cards.
 * - A link within one column runs round the column's outer side, in a lane of
 *   its own.
 *
 * Lanes keep to either side of a gap's middle, where the brackets turn, each
 * family of them beside one column — so no lane runs along an upright. Two
 * links share a lane only where they never meet in it (`takeLane`), so edges
 * that join no card in common never run along one another while a gap has
 * lanes to spare.
 */
function createRouter(
  routePoints: EdgePoint[],
  /** The cards standing in each column, by column. */
  cardsByColumn: ReadonlyMap<number, readonly CircularEdgeRect[]>
) {
  /** Each family of lanes beside a column, and the heights each lane is taken over. */
  const lanes = new Map<string, Array<Array<readonly [number, number]>>>()
  const crossings: Crossing[] = []
  /** Where each column's cards send edges into the gaps beside it: their middles, top to bottom. */
  const stubHeightsByColumn = new Map(
    [...cardsByColumn.entries()].map(([column, cards]) => [
      column,
      cards.map(card => card.y + card.height / 2).sort((above, below) => above - below)
    ])
  )
  /** Each run of columns links cross, worked out once for all of them. */
  const crossedByRun = new Map<string, CrossedColumns>()
  /** The columns strictly between `nearer` and `further`, by their column numbers. */
  const getCrossed = (nearer: number, further: number): CrossedColumns => {
    const key = `${nearer}:${further}`
    const known = crossedByRun.get(key)
    if (known) {
      return known
    }

    const cards: CircularEdgeRect[] = []
    for (let column = nearer + 1; column < further; column += 1) {
      cards.push(...(cardsByColumn.get(column) ?? []))
    }
    const crossed = getCrossedColumns(cards)
    crossedByRun.set(key, crossed)
    return crossed
  }

  /**
   * How far from its column a link turns, between `fromY` and `toY`: in the
   * lane nearest the column that no other link turns in over those heights,
   * or — beside a column too crowded for that — the one fewest others share.
   * A gap with no column beyond it has no brackets turning in its middle, so
   * there lanes go on out as far as the links need.
   */
  const takeLane = (key: string, fromY: number, toY: number, isOuterGap = false): number => {
    const top = Math.min(fromY, toY) - LANE_CLEARANCE
    const bottom = Math.max(fromY, toY) + LANE_CLEARANCE
    const family = lanes.get(key) ?? []
    lanes.set(key, family)
    const meets = ([start, end]: readonly [number, number]) => start < bottom && end > top

    let chosen = family.findIndex(taken => !taken.some(meets))
    if (chosen === -1 && (isOuterGap || family.length < LANE_COUNT)) {
      chosen = family.length
      family.push([])
    }
    if (chosen === -1) {
      let fewestMet = Number.POSITIVE_INFINITY
      for (const [index, taken] of family.entries()) {
        const met = taken.filter(meets).length
        if (met < fewestMet) {
          chosen = index
          fewestMet = met
        }
      }
    }

    family[chosen]?.push([top, bottom])
    return chosen * LANE_STEP + LANE_START
  }
  /** Whether nothing stands beyond a column, on the side away from the middle. */
  const isOutermost = (side: BracketSide, column: number) =>
    !cardsByColumn.has(side === 'left' ? column - 1 : column + 1)

  function route(params: {
    kind: Exclude<BracketEdgeKind, 'self'>
    side: BracketSide
    source: RoutedNode
    target: RoutedNode
    cycleIds: number[]
  }): RoutedEdge {
    const { kind, side, source, target, cycleIds } = params
    const sourceColumn = getColumn(source)
    const targetColumn = getColumn(target)
    let points: EdgePoint[]
    let handles: readonly [BracketHandle, BracketHandle]
    let label: CircularLabelSpot | null = null
    let lane: LabelLane | null = null
    const upright = (x: number, from: EdgePoint, to: EdgePoint, reach: LabelLane['reach']): LabelLane => ({
      x,
      top: Math.min(from.y, to.y),
      bottom: Math.max(from.y, to.y),
      reach
    })

    if (sourceColumn < targetColumn && kind === 'link') {
      // A link into the next column out that is no branch of the bracket
      // would, turning halfway across, run along the upright of another
      // module's branches and read as one of them. It turns in a lane beside
      // the column further out, and crosses the gap level with the module
      // nearer the middle, where only that module's own branches run.
      const from = rightOf(source)
      const to = leftOf(target)
      const offset = takeLane(`back:${side}:${sourceColumn}`, from.y, to.y)
      const turn = side === 'left' ? from.x + offset : to.x - offset
      points = from.y === to.y
        ? [from, to]
        : [from, { x: turn, y: from.y }, { x: turn, y: to.y }, to]
      handles = ['right-source', 'left-target']
      lane = upright(turn, from, to, side === 'left' ? 'right' : 'left')
    } else if (sourceColumn < targetColumn) {
      const from = rightOf(source)
      const to = leftOf(target)
      const turn = (from.x + to.x) / 2
      points = from.y === to.y
        ? [from, to]
        : [from, { x: turn, y: from.y }, { x: turn, y: to.y }, to]
      handles = ['right-source', 'left-target']
      // A tree edge's label goes on the stretch only it runs along: beside the
      // module further out, before the branches of its parent join.
      if (kind === 'tree') {
        const spot = side === 'left'
          ? { x: from.x + TREE_LABEL_INSET, y: from.y }
          : { x: to.x - TREE_LABEL_INSET, y: to.y }
        label = { labelX: spot.x, labelY: spot.y, ...LABEL_CENTERED }
      }
    } else if (sourceColumn > targetColumn) {
      const from = leftOf(source)
      const to = rightOf(target)
      const turnKey = `back:${side}:${targetColumn}`
      // On the left the lane hugs the column it ends in, on the right the
      // column across the gap from it: its label reaches away from either.
      const turnAt = (offset: number) => side === 'left' ? to.x + offset : to.x + COLUMN_GAP - offset
      const reach = side === 'left' ? 'right' : 'left'
      handles = ['left-source', 'right-target']

      if (sourceColumn - targetColumn === 1) {
        const turn = turnAt(takeLane(turnKey, from.y, to.y))
        points = [from, { x: turn, y: from.y }, { x: turn, y: to.y }, to]
        lane = upright(turn, from, to, reach)
      } else {
        // Further than the next column, a straight run would pass behind the
        // cards of the columns between and read as an edge of theirs. It
        // crosses them in the free channel between their rows nearest the
        // way it is going — off the middles of the other cards at its two
        // ends, where their edges leave them — turning into it in a lane
        // beside its own column, of the family already turning there, and
        // out of it beside the column it ends in.
        const channel = findChannel({
          columns: getCrossed(targetColumn, sourceColumn),
          crossings,
          stubs: [
            { heights: stubHeightsByColumn.get(sourceColumn) ?? [], own: from.y },
            { heights: stubHeightsByColumn.get(targetColumn) ?? [], own: to.y }
          ],
          fromY: from.y,
          toY: to.y,
          left: to.x,
          right: from.x
        })
        const exit = side === 'left'
          ? from.x - takeLane(`same:${side}:${sourceColumn}`, from.y, channel, isOutermost(side, sourceColumn))
          : from.x - takeLane(`back:${side}:${sourceColumn - 1}`, from.y, channel)
        const turn = turnAt(takeLane(turnKey, channel, to.y))
        crossings.push({ y: channel, left: Math.min(exit, turn), right: Math.max(exit, turn) })
        points = [
          from,
          { x: exit, y: from.y },
          { x: exit, y: channel },
          { x: turn, y: channel },
          { x: turn, y: to.y },
          to
        ]
        lane = upright(turn, { x: turn, y: channel }, to, reach)
      }
    } else {
      const from = side === 'left' ? leftOf(source) : rightOf(source)
      const to = side === 'left' ? leftOf(target) : rightOf(target)
      const offset = takeLane(`same:${side}:${sourceColumn}`, from.y, to.y, isOutermost(side, sourceColumn))
      const turn = side === 'left' ? from.x - offset : from.x + offset
      points = [from, { x: turn, y: from.y }, { x: turn, y: to.y }, to]
      handles = side === 'left'
        ? ['left-source', 'left-target']
        : ['right-source', 'right-target']
      lane = upright(turn, from, to, side)
    }

    routePoints.push(...points)

    return {
      edge: {
        id: getEdgeId(kind, source.id, target.id),
        source: source.id,
        target: target.id,
        sourceHandle: handles[0],
        targetHandle: handles[1],
        kind,
        side,
        cycleIds,
        path: roundedPolylinePath(points, CORNER_RADIUS),
        label: null
      },
      points,
      label,
      lane
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
  ): RoutedEdge {
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
      edge: {
        id: getEdgeId('self', node.id, node.id),
        source: node.id,
        target: node.id,
        sourceHandle: 'right-source',
        targetHandle: 'right-target',
        kind: 'self',
        side,
        cycleIds,
        path: geometry.path,
        label: null
      },
      points: geometry.points,
      label: {
        labelX: geometry.labelX,
        labelY: geometry.labelY,
        labelTransform: geometry.labelTransform,
        labelAnchor: geometry.labelAnchor
      },
      lane: null
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
