import type { AutoLayoutFallbackReason } from './module-graph-auto-layout.ts'

/**
 * Where a graph viewer's automatic layout stands, as its root says it in
 * `data-layout-state`, and whether its canvas is on screen yet.
 *
 * - `loading-engine`: a layout waits for ELK — its module to load and its
 *   worker to answer a first layout.
 * - `arranging`: ELK is up, and is laying this graph out.
 * - `ready`: a final arrangement is drawn and fitted: ELK's, a saved one, or
 *   one the visitor made.
 * - `failed`: ELK failed, and the simple arrangement is drawn in its place.
 *
 * Every step is driven by a real signal — a layout asked for, ELK's first
 * answer, a layout drawn — never by time passing.
 */
export type ModuleLayoutState = 'loading-engine' | 'arranging' | 'ready' | 'failed'

/**
 * The canvas is held back, hidden but measured, until its first arrangement
 * is drawn and fitted, and from then on stays shown: a later layout keeps the
 * drawing on screen until its own lands.
 */
export type ModuleLayoutStatus
  = | { state: 'loading-engine' | 'arranging', isCanvasShown: boolean }
    | { state: 'ready', isCanvasShown: true }
    | { state: 'failed', isCanvasShown: true, failure: AutoLayoutFallbackReason }

export type ModuleLayoutEvent
  /** An automatic layout was asked for, ELK up already or not. */
  = | { type: 'requested', isEngineReady: boolean }
    /** ELK came up — finished its first layout — while a layout waited for it. */
    | { type: 'engine-ready' }
    /** ELK's layout was drawn and the canvas fitted to it. */
    | { type: 'laid-out' }
    /** ELK failed, and the simple arrangement was drawn and fitted instead. */
    | { type: 'fell-back', failure: AutoLayoutFallbackReason }
    /** A saved arrangement, or one the visitor made, was drawn in its place. */
    | { type: 'arrangement-drawn' }

/**
 * How a viewer starts: drawing its arrangement at once when it has one, and
 * otherwise waiting, canvas hidden, for its first automatic layout.
 */
export function initialModuleLayoutStatus(params: {
  hasArrangement: boolean
}): ModuleLayoutStatus {
  return params.hasArrangement
    ? { state: 'ready', isCanvasShown: true }
    : { state: 'loading-engine', isCanvasShown: false }
}

export function nextModuleLayoutStatus(
  status: ModuleLayoutStatus,
  event: ModuleLayoutEvent
): ModuleLayoutStatus {
  switch (event.type) {
    case 'requested':
      return {
        state: event.isEngineReady ? 'arranging' : 'loading-engine',
        isCanvasShown: status.isCanvasShown
      }
    case 'engine-ready':
      // Heard late — from a layout another has overtaken — it changes nothing.
      return status.state === 'loading-engine'
        ? { state: 'arranging', isCanvasShown: status.isCanvasShown }
        : status
    case 'laid-out':
    case 'arrangement-drawn':
      return { state: 'ready', isCanvasShown: true }
    case 'fell-back':
      return { state: 'failed', isCanvasShown: true, failure: event.failure }
    default: {
      const exhaustive: never = event
      return exhaustive
    }
  }
}

/** Whether a layout is still to land: the viewer's `aria-busy`. */
export function isModuleLayoutPending(status: ModuleLayoutStatus): boolean {
  return status.state === 'loading-engine' || status.state === 'arranging'
}

/** What the viewer's status line says while a layout is still to land. */
export function moduleLayoutProgressText(status: ModuleLayoutStatus): string | undefined {
  switch (status.state) {
    case 'loading-engine':
      return 'Loading layout engine…'
    case 'arranging':
      return 'Arranging graph…'
    case 'ready':
    case 'failed':
      return undefined
    default: {
      const exhaustive: never = status
      return exhaustive
    }
  }
}

/** What the viewer says when ELK failed and the simple arrangement is drawn. */
export function moduleLayoutFailureText(failure: AutoLayoutFallbackReason): string {
  switch (failure) {
    case 'engine':
      return 'Couldn’t load the layout engine. Showing a simple arrangement.'
    case 'layout':
      return 'Couldn’t arrange this graph. Showing a simple arrangement.'
    default: {
      const exhaustive: never = failure
      return exhaustive
    }
  }
}
