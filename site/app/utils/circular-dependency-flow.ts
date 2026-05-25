import { MarkerType, Position } from '@vue-flow/core'
import type { Node, Edge } from '@vue-flow/core'
import type { CircularDependencyIssue } from '~/utils/circular-dependency-issues'

export type CircularIssueFlowNodeData = {
  label: string
  isEndpoint: boolean
}

export type CircularIssueFlowNode = Node<
  CircularIssueFlowNodeData,
  Record<string, never>,
  'issuePath'
>

export type CircularIssueFlowEdge = Edge<
  { isBackwardEdge: boolean },
  Record<string, never>,
  'issuePath'
>

export type CircularIssueFlow = {
  nodes: CircularIssueFlowNode[]
  edges: CircularIssueFlowEdge[]
}

const ISSUE_PATH_NODE_WIDTH = 200
const ISSUE_PATH_NODE_HEIGHT = 42
const ISSUE_PATH_NODE_GAP = 90
const ISSUE_PATH_EDGE_COLOR = '#facc15'

export function buildCircularIssueFlow(
  issue: Pick<CircularDependencyIssue, 'id' | 'path' | 'from' | 'to'>
): CircularIssueFlow {
  const path = issue.path.length > 0 ? issue.path : [issue.from, issue.to]
  const orderedLabels: string[] = []
  const nodeIdByLabel = new Map<string, string>()
  const nodeIndexByLabel = new Map<string, number>()
  for (const label of path) {
    if (!nodeIdByLabel.has(label)) {
      const nodeIndex = orderedLabels.length
      const nodeId = `issue-path-${issue.id}-node-${nodeIndex}`
      nodeIdByLabel.set(label, nodeId)
      nodeIndexByLabel.set(label, nodeIndex)
      orderedLabels.push(label)
    }
  }

  const firstLabel = path[0] || issue.from
  const lastLabel = path[path.length - 1] || issue.to
  const nodes: CircularIssueFlowNode[] = orderedLabels.map((label, index) => ({
    id: nodeIdByLabel.get(label) || `issue-path-${issue.id}-node-${index}`,
    type: 'issuePath',
    position: {
      x: index * (ISSUE_PATH_NODE_WIDTH + ISSUE_PATH_NODE_GAP),
      y: 0
    },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    draggable: false,
    connectable: false,
    selectable: false,
    data: {
      label,
      isEndpoint: label === firstLabel || label === lastLabel
    },
    style: {
      width: `${ISSUE_PATH_NODE_WIDTH}px`,
      height: `${ISSUE_PATH_NODE_HEIGHT}px`
    }
  }))

  const edges: CircularIssueFlowEdge[] = []
  for (let index = 0; index < path.length - 1; index += 1) {
    const sourceLabel = path[index] || ''
    const targetLabel = path[index + 1] || ''
    const sourceNodeId = nodeIdByLabel.get(sourceLabel)
    const targetNodeId = nodeIdByLabel.get(targetLabel)
    if (!sourceNodeId || !targetNodeId) {
      continue
    }

    const sourceIndex = nodeIndexByLabel.get(sourceLabel) ?? -1
    const targetIndex = nodeIndexByLabel.get(targetLabel) ?? -1
    const isBackwardEdge = targetIndex <= sourceIndex

    edges.push({
      id: `issue-path-${issue.id}-edge-${index}`,
      source: sourceNodeId,
      target: targetNodeId,
      sourceHandle: isBackwardEdge ? 'source-bottom' : 'source-right',
      targetHandle: isBackwardEdge ? 'target-bottom' : 'target-left',
      type: 'issuePath',
      style: {
        stroke: ISSUE_PATH_EDGE_COLOR,
        strokeWidth: 1.8
      },
      data: {
        isBackwardEdge
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: ISSUE_PATH_EDGE_COLOR
      }
    })
  }

  return { nodes, edges }
}
