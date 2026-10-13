import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  CIRCULAR_LABEL_MAX_SCALE,
  formatCircularEdgeLabel,
  getCircularEdgeBounds,
  getCircularEdgeGeometry,
  getCircularLabelBox,
  getCircularLabelPlacement,
  getCircularLabelScale,
  unionRects,
  type CircularEdgeGeometry
} from './circular-dependency-edge.ts'

const NODE_HALF_HEIGHT = 18

/**
 * The geometry of an edge between two different nodes, each end given as its
 * handle's point and the side that handle sits on.
 */
function between(
  source: { x: number, y: number, side: string },
  target: { x: number, y: number, side: string }
): CircularEdgeGeometry {
  return getCircularEdgeGeometry({
    sourceX: source.x,
    sourceY: source.y,
    sourcePosition: source.side,
    targetX: target.x,
    targetY: target.y,
    targetPosition: target.side,
    isSelfLoop: false
  })
}

describe('getCircularEdgeGeometry', () => {
  test('a self-loop on the right leaves and re-enters that side, label just past the loop', () => {
    const loop = getCircularEdgeGeometry({
      sourceX: 200,
      sourceY: 16,
      sourcePosition: 'right',
      // The target handle is on the same node, and a self-loop ignores it.
      targetX: 0,
      targetY: 16,
      targetPosition: 'left',
      isSelfLoop: true
    })
    const [start, first, second, end] = loop.points

    assert.equal(start.x, 200)
    assert.equal(end.x, 200)
    assert.ok(start.y < 16 && end.y > 16, 'leaves on one side of the handle, returns on the other')
    assert.ok(first.x > 200 && second.x > 200, 'reaches out of the node')
    assert.ok(loop.labelX > 230, 'label sits past the loop rather than on it')
    assert.equal(loop.labelY, 16)
    assert.equal(loop.labelTransform, 'translate(0, -50%)')
    assert.ok(loop.path.startsWith('M 200,8 C '))
  })

  test('a self-loop at the bottom reaches down, label below it', () => {
    const loop = getCircularEdgeGeometry({
      sourceX: 100,
      sourceY: 32,
      sourcePosition: 'bottom',
      targetX: 100,
      targetY: 32,
      targetPosition: 'bottom',
      isSelfLoop: true
    })

    assert.equal(loop.points[0].y, 32)
    assert.equal(loop.points[3].y, 32)
    assert.notEqual(loop.points[0].x, loop.points[3].x)
    assert.equal(loop.labelX, 100)
    assert.ok(loop.labelY > 32 + 30)
    assert.equal(loop.labelTransform, 'translate(-50%, 0)')
  })

  test('the two edges of a pair bow apart instead of overlapping', () => {
    const forward = between({ x: 200, y: 16, side: 'right' }, { x: 252, y: 16, side: 'left' })
    const backward = between({ x: 252, y: 16, side: 'left' }, { x: 200, y: 16, side: 'right' })

    assert.deepEqual(forward.points[0], { x: 200, y: 16 })
    assert.deepEqual(forward.points[3], { x: 252, y: 16 })
    assert.deepEqual(backward.points[0], { x: 252, y: 16 })
    assert.deepEqual(backward.points[3], { x: 200, y: 16 })
    assert.ok(forward.labelY < 16, 'travelling right, it bows up')
    assert.ok(backward.labelY > 16, 'travelling left, it bows down')
    assert.equal(16 - forward.labelY, backward.labelY - 16)
    assert.equal(forward.labelTransform, 'translate(-50%, -50%)')
  })

  test('a pair stacked vertically bows apart sideways', () => {
    const down = between({ x: 100, y: 40, side: 'bottom' }, { x: 100, y: 140, side: 'top' })
    const up = between({ x: 100, y: 140, side: 'top' }, { x: 100, y: 40, side: 'bottom' })

    assert.ok(down.labelX > 100)
    assert.ok(up.labelX < 100)
  })

  test('an edge that doubles back passes below the nodes, not through them', () => {
    // The deep dive's closing edge: out of a right-hand column's right side,
    // into a left-hand column's left side, on one row.
    const closing = between({ x: 900, y: 18, side: 'right' }, { x: 340, y: 18, side: 'left' })

    assert.deepEqual(closing.points[0], { x: 900, y: 18 })
    assert.deepEqual(closing.points[3], { x: 340, y: 18 })
    assert.ok(closing.points[1].y > 18 + NODE_HALF_HEIGHT)
    assert.ok(closing.points[2].y > 18 + NODE_HALF_HEIGHT)
    assert.ok(closing.labelY > 18 + NODE_HALF_HEIGHT + 20)
    assert.equal(closing.labelX, 620)
  })

  test('an edge whose handles face each other bows only gently', () => {
    const step = between({ x: 560, y: 18, side: 'right' }, { x: 680, y: 18, side: 'left' })

    assert.ok(Math.abs(step.labelY - 18) <= 20)
  })

  test('two handles at one point still give a finite curve', () => {
    const collapsed = between({ x: 10, y: 10, side: 'right' }, { x: 10, y: 10, side: 'left' })

    for (const point of collapsed.points) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
    }
    assert.ok(Number.isFinite(collapsed.labelX) && Number.isFinite(collapsed.labelY))
    assert.ok(!collapsed.path.includes('NaN'))
  })
})

describe('getCircularLabelScale', () => {
  test('a label is never shrunk below its own size by zooming out', () => {
    assert.equal(getCircularLabelScale(2), 1)
    assert.equal(getCircularLabelScale(1), 1)
    assert.equal(getCircularLabelScale(0.5), 2)
  })

  test('enlargement stops at the cap, and a broken zoom takes the cap', () => {
    assert.equal(getCircularLabelScale(0.1), CIRCULAR_LABEL_MAX_SCALE)
    assert.equal(getCircularLabelScale(0), CIRCULAR_LABEL_MAX_SCALE)
    assert.equal(getCircularLabelScale(Number.NaN), CIRCULAR_LABEL_MAX_SCALE)
  })
})

describe('getCircularLabelPlacement', () => {
  test('a curve label is centred on its point and scaled about its centre', () => {
    const geometry = between({ x: 0, y: 0, side: 'right' }, { x: 200, y: 0, side: 'left' })

    assert.deepEqual(getCircularLabelPlacement(geometry, 2), {
      transform: `translate(${geometry.labelX}px, ${geometry.labelY}px) translate(-50%, -50%) scale(2)`,
      transformOrigin: '50% 50%'
    })
  })

  test('a self-loop label grows away from the loop, about the side touching it', () => {
    const loop = getCircularEdgeGeometry({
      sourceX: 200,
      sourceY: 16,
      sourcePosition: 'right',
      targetX: 0,
      targetY: 16,
      targetPosition: 'left',
      isSelfLoop: true
    })

    assert.equal(getCircularLabelPlacement(loop, 1).transformOrigin, '0% 50%')
  })
})

describe('getCircularLabelBox and getCircularEdgeBounds', () => {
  const curve = between({ x: 0, y: 0, side: 'right' }, { x: 200, y: 0, side: 'left' })

  test('a centred label box straddles its point, and doubles with the scale', () => {
    const box = getCircularLabelBox(curve, '#4')
    const scaled = getCircularLabelBox(curve, '#4', 2)

    assert.equal(box.x + box.width / 2, curve.labelX)
    assert.equal(box.y + box.height / 2, curve.labelY)
    assert.equal(scaled.width, box.width * 2)
    assert.equal(scaled.height, box.height * 2)
  })

  test('an edge\'s bounds hold its whole curve and its label', () => {
    const bounds = getCircularEdgeBounds(curve, '#4')
    const label = getCircularLabelBox(curve, '#4')

    for (const point of curve.points) {
      assert.ok(point.x >= bounds.x && point.x <= bounds.x + bounds.width)
      assert.ok(point.y >= bounds.y && point.y <= bounds.y + bounds.height)
    }
    assert.ok(label.y >= bounds.y)
    assert.ok(label.y + label.height <= bounds.y + bounds.height)
  })

  test('an edge with no label is bounded by its curve alone', () => {
    const bounds = getCircularEdgeBounds(curve, '')

    assert.equal(bounds.y, Math.min(...curve.points.map(point => point.y)))
  })

  test('unionRects joins boxes, and has nothing to join for none', () => {
    assert.deepEqual(
      unionRects([{ x: 0, y: 0, width: 10, height: 10 }, { x: -5, y: 5, width: 10, height: 20 }]),
      { x: -5, y: 0, width: 15, height: 25 }
    )
    assert.equal(unionRects([]), null)
  })
})

describe('formatCircularEdgeLabel', () => {
  test('names the cycles by id, as the issues page numbers them', () => {
    assert.equal(formatCircularEdgeLabel([3]), '#3')
    assert.equal(formatCircularEdgeLabel([5, 3]), '#3 #5')
  })

  test('lists two ids and counts the rest', () => {
    assert.equal(formatCircularEdgeLabel([9, 3, 5, 7]), '#3 #5 +2')
  })

  test('lists a repeated id once', () => {
    assert.equal(formatCircularEdgeLabel([4, 4]), '#4')
  })

  test('an edge on no cycle has no label', () => {
    assert.equal(formatCircularEdgeLabel([]), '')
  })
})
