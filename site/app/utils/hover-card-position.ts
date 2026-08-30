/**
 * Places a hover card inside the graph viewer without letting it fall outside.
 *
 * The viewer clips its own overflow, so a card anchored to a node near an edge
 * would simply be cut in half. Positions are therefore resolved against the
 * viewer's box rather than the window's, and kept whole inside it.
 */

/** A box measured relative to the viewer, not the page. */
export type HoverCardBox = {
  left: number
  top: number
  width: number
  height: number
}

export type HoverCardSize = {
  width: number
  height: number
}

export type HoverCardPosition = {
  left: number
  top: number
  /** Which side of the anchor the card ended up on, for the caller's styling. */
  placement: 'above' | 'below'
}

/** Gap between the anchor and the card. */
const DEFAULT_ANCHOR_OFFSET = 10
/** Gap kept between the card and the viewer's own edges. */
const DEFAULT_VIEWPORT_MARGIN = 8

/**
 * Keeps a coordinate between two bounds, preferring `min` when they cross.
 *
 * They cross whenever the card is larger than the space it has to fit in, and
 * pinning that card to the near edge is what leaves it readable.
 */
function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min
  }

  return Math.min(Math.max(value, min), max)
}

/**
 * Resolves where a card of a known size should sit next to an anchor.
 *
 * Below the anchor is the default; the card flips above when it does not fit
 * below and there is more room there. Either way the result is clamped into the
 * viewer, so a card larger than the space available is pinned to the margin and
 * scrolls internally rather than spilling out of view.
 */
export function resolveHoverCardPosition(params: {
  anchor: HoverCardBox
  viewport: HoverCardSize
  card: HoverCardSize
  anchorOffset?: number
  viewportMargin?: number
}): HoverCardPosition {
  const {
    anchor,
    viewport,
    card,
    anchorOffset = DEFAULT_ANCHOR_OFFSET,
    viewportMargin = DEFAULT_VIEWPORT_MARGIN
  } = params

  const spaceBelow = viewport.height - (anchor.top + anchor.height)
  const spaceAbove = anchor.top
  const fitsBelow = spaceBelow >= card.height + anchorOffset + viewportMargin
  const placement
    = fitsBelow || spaceBelow >= spaceAbove ? 'below' : 'above'

  const unclampedTop
    = placement === 'below'
      ? anchor.top + anchor.height + anchorOffset
      : anchor.top - anchorOffset - card.height

  const left = clamp(
    anchor.left + anchor.width / 2 - card.width / 2,
    viewportMargin,
    viewport.width - card.width - viewportMargin
  )
  const top = clamp(
    unclampedTop,
    viewportMargin,
    viewport.height - card.height - viewportMargin
  )

  return { left, top, placement }
}
