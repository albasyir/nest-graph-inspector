import type {
  GraphOutput,
  GraphOutputCycle,
  GraphOutputCycleType,
  GraphOutputProviderCycle
} from 'nest-graph-inspector'

export type CircularDependencyIssueCategory
  = | 'module'
    | 'provider'
    | 'controller'

export type CircularDependencyIssue = {
  id: number
  category: CircularDependencyIssueCategory
  type: GraphOutputCycleType
  from: string
  to: string
  path: string[]
}

export const circularDependencyCategoryLabel: Record<
  CircularDependencyIssueCategory,
  string
> = {
  module: 'Module',
  provider: 'Provider',
  controller: 'Controller'
}

function splitDependencyCycleKey(
  key: string
): { moduleName: string, token: string } | null {
  const separatorIndex = key.indexOf(':')
  if (separatorIndex === -1) {
    return null
  }

  return {
    moduleName: key.slice(0, separatorIndex),
    token: key.slice(separatorIndex + 1)
  }
}

function formatDependencyCyclePath(path: string[]): string[] {
  return path.map((key) => {
    const parsedKey = splitDependencyCycleKey(key)
    if (!parsedKey) {
      return key
    }

    return `${parsedKey.token} from ${parsedKey.moduleName}`
  })
}

function formatProviderCyclePath(
  path: GraphOutputProviderCycle['path']
): string[] {
  return path.map(item => `${item.provider.name} from ${item.module.name}`)
}

export function resolveCircularDependencyEndpoints(path: string[]): {
  from: string
  to: string
} {
  const from = path[0] || 'Unknown'
  const to = path[1] || path[0] || 'Unknown'

  return { from, to }
}

function mapGraphCycleToIssue(
  cycle: Pick<GraphOutputCycle, 'id' | 'type'>,
  category: CircularDependencyIssueCategory,
  path: string[]
): CircularDependencyIssue {
  const { from, to } = resolveCircularDependencyEndpoints(path)

  return {
    id: cycle.id,
    category,
    type: cycle.type,
    from,
    to,
    path
  }
}

export function collectCircularDependencyIssues(
  graphData: GraphOutput | null | undefined
): CircularDependencyIssue[] {
  const cycles = graphData?.cycles
  if (!cycles) {
    return []
  }

  const moduleIssues = cycles.modules.map(cycle =>
    mapGraphCycleToIssue(cycle, 'module', cycle.path)
  )

  const providerIssues = cycles.providers.map(cycle =>
    mapGraphCycleToIssue(cycle, 'provider', formatProviderCyclePath(cycle.path))
  )

  const controllerIssues = cycles.controllers.map(cycle =>
    mapGraphCycleToIssue(
      cycle,
      'controller',
      formatDependencyCyclePath(cycle.path)
    )
  )

  return [...moduleIssues, ...providerIssues, ...controllerIssues].sort(
    (a, b) => a.id - b.id
  )
}
