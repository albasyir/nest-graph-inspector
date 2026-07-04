import { MarkerType, type Edge, type Node } from '@vue-flow/core'
import type { RuntimeTrace } from './direct-run-provider'

type SequenceParticipant = {
  id: string
  label: string
  subtitle: string
  column: number
}

type SequenceNodeData = {
  label: string
  subtitle: string
  kind: 'participant' | 'step'
  status?: string
  durationMs?: number
}

type SequenceEdgeData = {
  durationMs: number
  status: string
}

export type RuntimeTraceSequenceNode = Node<SequenceNodeData>
export type RuntimeTraceSequenceEdge = Edge<SequenceEdgeData>

export type RuntimeTraceSequenceDiagram = {
  nodes: RuntimeTraceSequenceNode[]
  edges: RuntimeTraceSequenceEdge[]
}

const PARTICIPANT_WIDTH = 180
const PARTICIPANT_HEIGHT = 64
const STEP_WIDTH = 190
const STEP_HEIGHT = 72
const COLUMN_GAP = 220
const ROW_GAP = 124
const ORIGIN_X = 24
const ORIGIN_Y = 24
const STEP_OFFSET_X = 24

function getParticipantKey(span: RuntimeTrace['spans'][number]): string {
  return span.className || span.name
}

function getParticipantSubtitle(span: RuntimeTrace['spans'][number]): string {
  if (span.moduleName && span.type) {
    return `${span.moduleName} · ${span.type}`
  }

  return span.type
}

function getStepLabel(span: RuntimeTrace['spans'][number]): string {
  return span.methodName ? `${span.methodName}()` : span.name
}

export function buildRuntimeTraceSequenceDiagram(
  trace: RuntimeTrace
): RuntimeTraceSequenceDiagram {
  const participants = new Map<string, SequenceParticipant>()
  const spanById = new Map(trace.spans.map(span => [span.spanId, span]))

  for (const span of trace.spans) {
    const key = getParticipantKey(span)
    if (!participants.has(key)) {
      participants.set(key, {
        id: `participant:${key}`,
        label: span.className || span.name,
        subtitle: getParticipantSubtitle(span),
        column: participants.size
      })
    }
  }

  const nodes: RuntimeTraceSequenceNode[] = Array.from(participants.values()).map(participant => ({
    id: participant.id,
    type: 'input',
    position: {
      x: ORIGIN_X + participant.column * COLUMN_GAP,
      y: ORIGIN_Y
    },
    draggable: false,
    selectable: false,
    data: {
      label: participant.label,
      subtitle: participant.subtitle,
      kind: 'participant'
    },
    style: {
      width: `${PARTICIPANT_WIDTH}px`,
      minHeight: `${PARTICIPANT_HEIGHT}px`
    }
  }))

  const edges: RuntimeTraceSequenceEdge[] = []

  for (const [index, span] of trace.spans.entries()) {
    const participant = participants.get(getParticipantKey(span))
    if (!participant) {
      continue
    }

    const parent = span.parentSpanId ? spanById.get(span.parentSpanId) : null
    const sourceParticipant = parent
      ? participants.get(getParticipantKey(parent)) || participant
      : participant
    const stepY = ORIGIN_Y + PARTICIPANT_HEIGHT + 36 + index * ROW_GAP
    const sourceX = ORIGIN_X + sourceParticipant.column * COLUMN_GAP
    const targetX = ORIGIN_X + participant.column * COLUMN_GAP
    const centerX = sourceX === targetX
      ? targetX
      : Math.round((sourceX + targetX) / 2)

    nodes.push({
      id: `step:${span.spanId}`,
      type: 'default',
      position: {
        x: centerX + STEP_OFFSET_X,
        y: stepY
      },
      draggable: false,
      selectable: false,
      data: {
        label: getStepLabel(span),
        subtitle: span.errorMessage || `${span.status} · ${span.durationMs} ms`,
        kind: 'step',
        status: span.status,
        durationMs: span.durationMs
      },
      style: {
        width: `${STEP_WIDTH}px`,
        minHeight: `${STEP_HEIGHT}px`
      }
    })

    edges.push({
      id: `edge:${span.spanId}`,
      source: sourceParticipant.id,
      target: `step:${span.spanId}`,
      markerEnd: MarkerType.ArrowClosed,
      label: `${participant.label} · ${span.durationMs} ms`,
      type: 'smoothstep',
      selectable: false,
      data: {
        durationMs: span.durationMs,
        status: span.status
      },
      style: {
        strokeWidth: 2
      }
    })

    edges.push({
      id: `edge:deliver:${span.spanId}`,
      source: `step:${span.spanId}`,
      target: participant.id,
      markerEnd: MarkerType.ArrowClosed,
      type: 'smoothstep',
      selectable: false,
      style: {
        strokeDasharray: '5 4',
        opacity: 0.7
      },
      data: {
        durationMs: span.durationMs,
        status: span.status
      }
    })
  }

  return { nodes, edges }
}
