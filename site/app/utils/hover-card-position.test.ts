import { strict as assert } from 'node:assert'
import { resolveHoverCardPosition } from './hover-card-position.ts'

const viewport = { width: 1000, height: 600 }
const card = { width: 320, height: 200 }

// Room below: the card sits under the node, centred on it.
assert.deepEqual(
  resolveHoverCardPosition({
    anchor: { left: 400, top: 100, width: 200, height: 40 },
    viewport,
    card
  }),
  { left: 340, top: 150, placement: 'below' }
)

// No room below and more above: the card flips rather than being clipped by the
// viewer, which hides its own overflow.
assert.deepEqual(
  resolveHoverCardPosition({
    anchor: { left: 400, top: 480, width: 200, height: 40 },
    viewport,
    card
  }),
  { left: 340, top: 270, placement: 'above' }
)

// A node against the left edge cannot centre the card there; it is kept inside
// the viewer margin instead.
assert.equal(
  resolveHoverCardPosition({
    anchor: { left: 0, top: 100, width: 120, height: 40 },
    viewport,
    card
  }).left,
  8
)

// Same on the right edge.
assert.equal(
  resolveHoverCardPosition({
    anchor: { left: 880, top: 100, width: 120, height: 40 },
    viewport,
    card
  }).left,
  1000 - 320 - 8
)

// A card taller than the viewer has nowhere to fit, so it is pinned to the top
// margin and left to scroll internally rather than spilling out of view.
assert.deepEqual(
  resolveHoverCardPosition({
    anchor: { left: 400, top: 20, width: 200, height: 40 },
    viewport: { width: 1000, height: 180 },
    card: { width: 320, height: 400 }
  }),
  { left: 340, top: 8, placement: 'below' }
)

// Offsets and margins are configurable, and both are respected.
assert.deepEqual(
  resolveHoverCardPosition({
    anchor: { left: 400, top: 100, width: 200, height: 40 },
    viewport,
    card,
    anchorOffset: 24,
    viewportMargin: 32
  }),
  { left: 340, top: 164, placement: 'below' }
)

console.log('hover-card-position.test.ts ok')
