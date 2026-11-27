/**
 * The landing page's blast-effect demo: one module of the demo application in
 * the middle of its dependency bracket — what it needs on the left, every
 * module a change to it would hit on the right — kept in place on the page.
 *
 * Pure: the component holds the state and draws it; this says what the state
 * starts as, how the visitor's moves change it, which module the graph lets it
 * draw, and how the finding beside it words the module's reach.
 */
import type { GraphOutput } from 'nest-graph-inspector'
import {
  DEFAULT_BRACKET_DEPTH,
  type BlastRadius,
  type BracketSide
} from './module-dependency-bracket.ts'

/**
 * The module the demo opens on. In the demo application a change to it
 * reaches furthest: nine modules, five levels deep — everything that takes a
 * customer, out to the shelves that stock a product. `DatabaseModule` reaches
 * more modules, but only because it is global: each one a single level away.
 */
export const BLAST_DEMO_MODULE = 'CustomerModule'

/** What the visitor has made of the demo: the module in the middle, and each side's depth. */
export type BlastDemoState = {
  center: string
  depth: Record<BracketSide, number>
}

/** The demo as it opens. */
export function startBlastDemo(): BlastDemoState {
  return {
    center: BLAST_DEMO_MODULE,
    depth: { left: DEFAULT_BRACKET_DEPTH, right: DEFAULT_BRACKET_DEPTH }
  }
}

/** Another module in the middle. The depths stay, as a module page's links keep them. */
export function recenterBlastDemo(state: BlastDemoState, moduleName: string): BlastDemoState {
  return { ...state, center: moduleName }
}

/** One side shown to another depth, the other side as it was. */
export function setBlastDemoDepth(
  state: BlastDemoState,
  side: BracketSide,
  depth: number
): BlastDemoState {
  return { ...state, depth: { ...state.depth, [side]: depth } }
}

/** Whether the demo is as it opened, with nothing to reset. */
export function isBlastDemoAtStart(state: BlastDemoState): boolean {
  const start = startBlastDemo()
  return state.center === start.center
    && state.depth.left === start.depth.left
    && state.depth.right === start.depth.right
}

/**
 * The module the demo draws in the middle of `graph`: the one asked for while
 * the graph has it, else the one the demo opens on, else the graph's root —
 * so a graph that lacks the module asked for, as the live demo's lacks the
 * static graph's `NestJSCoreModule`, still draws one. `null` only for a graph
 * with none of them.
 */
export function resolveBlastDemoCenter(
  graph: Pick<GraphOutput, 'modules' | 'root'>,
  requested: string
): string | null {
  const candidates = [requested, BLAST_DEMO_MODULE, graph.root]
  return candidates.find(name => Object.hasOwn(graph.modules, name)) ?? null
}

/** How the finding words a module's blast radius. */
export type BlastRadiusWords
  = | { kind: 'contained' }
    | { kind: 'reaches', modules: string, distance: string }

/**
 * A blast radius in words: how many modules a change reaches, and how far —
 * "9 modules, up to 5 levels away"; "1 module, directly" — or that nothing
 * depends on the module at all.
 */
export function describeBlastRadius(radius: BlastRadius): BlastRadiusWords {
  if (radius.modules === 0) {
    return { kind: 'contained' }
  }

  const modules = `${radius.modules} ${radius.modules === 1 ? 'module' : 'modules'}`
  if (radius.levels <= 1) {
    return { kind: 'reaches', modules, distance: radius.modules === 1 ? 'directly' : 'all directly' }
  }

  return { kind: 'reaches', modules, distance: `up to ${radius.levels} levels away` }
}
