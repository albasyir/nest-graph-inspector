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
  placeRouteLabels,
  unionRects,
  type CircularEdgeGeometry,
  type CircularEdgePoint,
  type CircularEdgeRect,
  type RouteLabelPlacement
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

describe('placeRouteLabels', () => {
  /** Places one label, `#1`, on `route` among `obstacles`. */
  function placeOne(
    route: CircularEdgePoint[],
    obstacles: CircularEdgeRect[] = []
  ): RouteLabelPlacement | undefined {
    return placeRouteLabels({ labels: [{ key: 'a', route, text: '#1' }], obstacles }).get('a')
  }

  function isApart(left: CircularEdgeRect, right: CircularEdgeRect): boolean {
    return left.x + left.width <= right.x || right.x + right.width <= left.x
      || left.y + left.height <= right.y || right.y + right.height <= left.y
  }

  test('centres a label on the middle of its route\'s longest stretch, clear at every zoom', () => {
    const spot = placeOne([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 300, y: 40 }, { x: 300, y: 60 }])

    assert.ok(spot)
    assert.equal(spot.labelX, 150)
    assert.equal(spot.labelY, 40)
    assert.equal(spot.labelTransform, 'translate(-50%, -50%)')
    assert.deepEqual(spot.labelAnchor, { x: 0.5, y: 0.5 })
    assert.equal(spot.clearScale, CIRCULAR_LABEL_MAX_SCALE)
  })

  test('slides along the stretch, off a module in its way', () => {
    const module = { x: 20, y: 160, width: 200, height: 80 }
    const spot = placeOne([{ x: 0, y: 0 }, { x: 0, y: 400 }], [module])

    assert.ok(spot)
    assert.equal(spot.labelX, 0)
    assert.equal(spot.labelY, 272)
    assert.equal(spot.clearScale, CIRCULAR_LABEL_MAX_SCALE)
    assert.ok(isApart(getCircularLabelBox(spot, '#1', CIRCULAR_LABEL_MAX_SCALE), module))
  })

  test('keeps clear of a label placed before it', () => {
    const placements = placeRouteLabels({
      labels: [
        { key: 'first', route: [{ x: 0, y: 0 }, { x: 0, y: 400 }], text: '#1' },
        { key: 'second', route: [{ x: 40, y: 0 }, { x: 40, y: 400 }], text: '#2' }
      ],
      obstacles: []
    })
    const first = placements.get('first')
    const second = placements.get('second')

    assert.ok(first && second)
    assert.equal(first.labelY, 200, 'the first label keeps the best spot')
    assert.equal(second.labelY, 256)
    assert.ok(isApart(
      getCircularLabelBox(first, '#1', CIRCULAR_LABEL_MAX_SCALE),
      getCircularLabelBox(second, '#2', CIRCULAR_LABEL_MAX_SCALE)
    ))
  })

  test('takes a shorter stretch when the longest has no room', () => {
    const spot = placeOne([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 150 }], [
      { x: -100, y: -500, width: 600, height: 480 },
      { x: -100, y: 20, width: 330, height: 480 }
    ])

    assert.ok(spot)
    assert.equal(spot.labelX, 300)
    assert.equal(spot.labelY, 75)
    assert.equal(spot.clearScale, CIRCULAR_LABEL_MAX_SCALE)
  })

  test('is clear at a smaller size where its route has no room for the largest, and says so', () => {
    const corridor = [
      { x: -500, y: -1000, width: 1400, height: 970 },
      { x: -500, y: 30, width: 1400, height: 1000 }
    ]
    const spot = placeOne([{ x: 0, y: 0 }, { x: 400, y: 0 }], corridor)

    assert.ok(spot)
    assert.equal(spot.clearScale, 2)
    assert.equal(spot.labelX, 200)
    for (const wall of corridor) {
      assert.ok(isApart(getCircularLabelBox(spot, '#1', spot.clearScale), wall))
    }
  })

  test('sits in the middle of the longest stretch when nothing on its route is clear', () => {
    const spot = placeOne(
      [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 300, y: 10 }],
      [{ x: -1000, y: -1000, width: 3000, height: 3000 }]
    )

    assert.ok(spot)
    assert.equal(spot.clearScale, 0)
    assert.equal(spot.labelX, 150)
    assert.equal(spot.labelY, 10)
  })

  test('moves along its route rather than hide another cycle\'s line', () => {
    const crossing = [{ x: 200, y: -100 }, { x: 200, y: 100 }]
    const placements = placeRouteLabels({
      labels: [{ key: 'a', route: [{ x: 0, y: 0 }, { x: 400, y: 0 }], text: '#1' }],
      obstacles: [],
      lines: [crossing]
    })
    const spot = placements.get('a')

    assert.ok(spot)
    assert.equal(spot.labelX, 264)
    assert.equal(spot.labelY, 0)
    assert.equal(spot.clearScale, CIRCULAR_LABEL_MAX_SCALE)
  })

  test('covers another line only where nowhere on its route keeps off it', () => {
    const spot = placeRouteLabels({
      labels: [{ key: 'a', route: [{ x: 0, y: 0 }, { x: 40, y: 0 }], text: '#1' }],
      obstacles: [],
      lines: [[{ x: 20, y: -100 }, { x: 20, y: 100 }]]
    }).get('a')

    assert.ok(spot)
    assert.equal(spot.labelX, 20, 'on the middle of its route, line and all')
    assert.equal(spot.clearScale, CIRCULAR_LABEL_MAX_SCALE, 'a line is no reason to shrink')
  })

  test('keeps to the middle of its route where the only line like it is its own', () => {
    const route = [{ x: 0, y: 0 }, { x: 400, y: 0 }]
    const spot = placeRouteLabels({
      labels: [{ key: 'a', route, text: '#1' }],
      obstacles: [],
      lines: [route, [...route]]
    }).get('a')

    assert.ok(spot)
    assert.equal(spot.labelX, 200)
  })

  test('has nowhere to put a label on no route, and one place on a route of one point', () => {
    assert.equal(placeOne([]), undefined)

    const spot = placeOne([{ x: 5, y: 7 }])
    assert.ok(spot)
    assert.equal(spot.labelX, 5)
    assert.equal(spot.labelY, 7)
  })
})
