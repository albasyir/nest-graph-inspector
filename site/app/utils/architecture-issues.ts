import type {
  GraphOutput,
  GraphOutputDependencyRef,
  GraphOutputModule
} from 'nest-graph-inspector'
import {
  circularDependencyCategoryLabel,
  collectCircularDependencyIssues
} from './circular-dependency-issues.ts'
import type { CircularDependencyIssue } from './circular-dependency-issues.ts'

export type ArchitectureIssueCategory
  = | 'circular'
    | 'duplicate-provider'
    | 'unused-import'
    | 'dead-export'
    | 'orphan-module'

export type ArchitectureIssueSeverity = 'error' | 'warning' | 'info'

export type ArchitectureIssue = {
  id: string
  category: ArchitectureIssueCategory
  severity: ArchitectureIssueSeverity
  title: string
  description: string
  remediation: string
  /** The module the issue is reported against, and the one to focus on. */
  module: string
  relatedModules?: string[]
  /** The provider token or imported module the issue is about. */
  target?: string
  circularIssue?: CircularDependencyIssue
}

export type ArchitectureIssuesSummary = {
  total: number
  errors: number
  warnings: number
  cleanups: number
  byCategory: Record<ArchitectureIssueCategory, number>
}

/** Display and sort order of the categories. */
export const ARCHITECTURE_ISSUE_CATEGORIES: readonly ArchitectureIssueCategory[] = [
  'circular',
  'duplicate-provider',
  'unused-import',
  'dead-export',
  'orphan-module'
]

export const architectureIssueCategoryLabel: Record<
  ArchitectureIssueCategory,
  string
> = {
  'circular': 'Circular Cycles',
  'duplicate-provider': 'Duplicate Providers',
  'unused-import': 'Unused Imports',
  'dead-export': 'Dead Exports',
  'orphan-module': 'Disconnected Modules'
}

export const architectureIssueCategoryIcon: Record<
  ArchitectureIssueCategory,
  string
> = {
  'circular': 'i-lucide-refresh-cw',
  'duplicate-provider': 'i-lucide-copy',
  'unused-import': 'i-lucide-unlink',
  'dead-export': 'i-lucide-package-x',
  'orphan-module': 'i-lucide-circle-off'
}

export const architectureIssueSeverityLabel: Record<
  ArchitectureIssueSeverity,
  string
> = {
  error: 'Error',
  warning: 'Warning',
  info: 'Cleanup'
}

export const architectureIssueSeverityIcon: Record<
  ArchitectureIssueSeverity,
  string
> = {
  error: 'i-lucide-octagon-alert',
  warning: 'i-lucide-triangle-alert',
  info: 'i-lucide-info'
}

/** Nuxt UI colors, so a severity reads the same on every badge. */
export const architectureIssueSeverityColor: Record<
  ArchitectureIssueSeverity,
  'error' | 'warning' | 'info'
> = {
  error: 'error',
  warning: 'warning',
  info: 'info'
}

/**
 * The virtual module the library folds NestJS core providers into. Nothing
 * imports it and nobody registered it, so it is never an architecture issue.
 */
export const NEST_CORE_MODULE_NAME = 'NestJSCoreModule'

const severityRank: Record<ArchitectureIssueSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2
}

// Not localeCompare: the order must not depend on the visitor's locale.
function compareText(a: string, b: string): number {
  if (a === b) {
    return 0
  }

  return a < b ? -1 : 1
}

function compareArchitectureIssues(
  a: ArchitectureIssue,
  b: ArchitectureIssue
): number {
  const categoryOrder = ARCHITECTURE_ISSUE_CATEGORIES.indexOf(a.category)
    - ARCHITECTURE_ISSUE_CATEGORIES.indexOf(b.category)

  return severityRank[a.severity] - severityRank[b.severity]
    || categoryOrder
    || compareText(a.module, b.module)
    || compareText(a.id, b.id)
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareText)
}

function moduleEntries(
  graphData: GraphOutput
): [string, GraphOutputModule][] {
  return Object.entries(graphData.modules)
    .filter(([moduleName]) => moduleName !== NEST_CORE_MODULE_NAME)
    .sort(([a], [b]) => compareText(a, b))
}

function moduleDependencies(
  module: GraphOutputModule
): GraphOutputDependencyRef[] {
  return [
    ...module.providers.flatMap(provider => provider.dependencies),
    ...module.controllers.flatMap(controller => controller.dependencies)
  ]
}

/** Labels read `Token from Module` for provider and controller cycles. */
function moduleOfCircularLabel(label: string): string {
  const separator = ' from '
  const separatorIndex = label.lastIndexOf(separator)
  return separatorIndex === -1
    ? label
    : label.slice(separatorIndex + separator.length)
}

function collectCircularIssues(graphData: GraphOutput): ArchitectureIssue[] {
  return collectCircularDependencyIssues(graphData).map((circularIssue) => {
    const modules = circularIssue.path.map(moduleOfCircularLabel)
    const module = modules[0] || moduleOfCircularLabel(circularIssue.from)
    const kind = circularDependencyCategoryLabel[circularIssue.category]
    const isDirect = circularIssue.type === 'direct'

    return {
      id: `circular:${circularIssue.category}:${circularIssue.id}`,
      category: 'circular',
      severity: 'error',
      title: `${kind} cycle: ${circularIssue.from} → ${circularIssue.to}`,
      description: `${isDirect ? 'A direct' : 'An indirect'} ${kind.toLowerCase()} dependency cycle (${circularIssue.path.join(' → ')}). NestJS cannot resolve either side until the other exists, so it only boots with forwardRef(), and the injected value may be undefined while constructors and onModuleInit run.`,
      remediation: circularIssue.category === 'module'
        ? 'Break the cycle by moving what both modules need into a shared module that each of them imports, or invert one dependency with an event or an interface. Keep forwardRef(() => Module) only as a stopgap.'
        : 'Extract the shared logic into a third provider both sides depend on, or decouple them with events or a ModuleRef lookup. If the cycle has to stay, wrap both injections in @Inject(forwardRef(() => Provider)).',
      module,
      relatedModules: uniqueSorted(modules.filter(name => name !== module)),
      target: circularIssue.to,
      circularIssue
    }
  })
}

function collectDuplicateProviderIssues(
  graphData: GraphOutput
): ArchitectureIssue[] {
  const modulesByProvider = new Map<string, string[]>()
  for (const [moduleName, module] of moduleEntries(graphData)) {
    for (const provider of module.providers) {
      const modules = modulesByProvider.get(provider.name) ?? []
      if (!modules.includes(moduleName)) {
        modules.push(moduleName)
      }
      modulesByProvider.set(provider.name, modules)
    }
  }

  return [...modulesByProvider.entries()]
    .filter(([, modules]) => modules.length > 1)
    .map(([providerName, modules]) => {
      const [module = '', ...relatedModules] = modules

      return {
        id: `duplicate-provider:${providerName}`,
        category: 'duplicate-provider',
        severity: 'error',
        title: `${providerName} is registered in ${modules.length} modules`,
        description: `${providerName} appears in the providers array of ${modules.join(', ')}. Each module's injector creates its own instance, so what should be a singleton exists ${modules.length} times: state kept in one copy is invisible to the others, and consumers silently diverge depending on which module they resolve it from.`,
        remediation: `Register ${providerName} in a single owning (or shared) module, add it to that module's exports, and import that module wherever ${providerName} is needed instead of listing it in each module's providers array.`,
        module,
        relatedModules,
        target: providerName
      }
    })
}

function reachableModules(
  graphData: GraphOutput,
  skippedEdge?: { from: string, to: string }
): Set<string> {
  const reachable = new Set<string>()
  const pending = graphData.modules[graphData.root] ? [graphData.root] : []

  while (pending.length > 0) {
    const moduleName = pending.pop() as string
    if (reachable.has(moduleName)) {
      continue
    }

    reachable.add(moduleName)
    for (const importedName of graphData.modules[moduleName]?.imports ?? []) {
      const isSkipped
        = skippedEdge?.from === moduleName && skippedEdge.to === importedName
      if (!isSkipped && graphData.modules[importedName]) {
        pending.push(importedName)
      }
    }
  }

  return reachable
}

/**
 * An import counts as used when the importer injects something resolved
 * through it, or passes it on in its own exports. Two kinds of import are
 * never reported, because their job is registration rather than injection:
 * the root module's (it composes the application), and one that is the only
 * path from the root to the imported module (removing it would unregister
 * that module, its controllers, and its side effects).
 */
function collectUnusedImportIssues(
  graphData: GraphOutput
): ArchitectureIssue[] {
  const issues: ArchitectureIssue[] = []
  const reachable = reachableModules(graphData)

  for (const [moduleName, module] of moduleEntries(graphData)) {
    // A disconnected module is reported as such; its imports are moot.
    if (moduleName === graphData.root || !reachable.has(moduleName)) {
      continue
    }

    const dependencies = moduleDependencies(module)
    for (const importedName of uniqueSorted(module.imports)) {
      const importedModule = graphData.modules[importedName]
      if (
        !importedModule
        || importedName === moduleName
        || importedName === NEST_CORE_MODULE_NAME
      ) {
        continue
      }

      const importedExports = new Set(importedModule.exports)
      const isInjected = dependencies.some(
        dependency =>
          dependency.providedBy.name === importedName
          || importedExports.has(dependency.token)
      )
      const isReExported = module.exports.some(
        exported => exported === importedName || importedExports.has(exported)
      )
      if (isInjected || isReExported) {
        continue
      }

      const isOnlyPathFromRoot = !reachableModules(graphData, {
        from: moduleName,
        to: importedName
      }).has(importedName)
      if (isOnlyPathFromRoot) {
        continue
      }

      issues.push({
        id: `unused-import:${moduleName}:${importedName}`,
        category: 'unused-import',
        severity: 'warning',
        title: `${moduleName} imports ${importedName} but never uses it`,
        description: `No provider or controller in ${moduleName} injects anything ${importedName} provides or exports, and ${moduleName} does not re-export it. ${importedName} is registered elsewhere in the application, so this import only adds an edge to the dependency tree.`,
        remediation: `Remove ${importedName} from the imports array of ${moduleName}. That keeps the dependency tree honest, trims what NestJS links at startup, and can retire a forwardRef() that existed only because of this import.`,
        module: moduleName,
        relatedModules: [importedName],
        target: importedName
      })
    }
  }

  return issues
}

type ExportConsumer = {
  name: string
  module: GraphOutputModule
  dependencies: GraphOutputDependencyRef[]
}

/**
 * Another module consumes an export when it injects the token through one of
 * its imports, or re-exports it from a module that imports the exporter.
 */
function consumesExport(
  consumer: ExportConsumer,
  exporterName: string,
  token: string
): boolean {
  if (consumer.name === exporterName) {
    return false
  }

  const injects = consumer.dependencies.some(
    dependency =>
      dependency.token === token
      && dependency.providedBy.name !== consumer.name
  )
  const reExports = consumer.module.imports.includes(exporterName)
    && consumer.module.exports.includes(token)

  return injects || reExports
}

function collectDeadExportIssues(graphData: GraphOutput): ArchitectureIssue[] {
  const issues: ArchitectureIssue[] = []
  const consumers: ExportConsumer[] = Object.entries(graphData.modules).map(
    ([name, module]) => ({
      name,
      module,
      dependencies: moduleDependencies(module)
    })
  )

  for (const [moduleName, module] of moduleEntries(graphData)) {
    for (const exported of uniqueSorted(module.exports)) {
      // Exporting a module re-exports it; only provider tokens can go unused.
      if (graphData.modules[exported]) {
        continue
      }

      if (consumers.some(consumer => consumesExport(consumer, moduleName, exported))) {
        continue
      }

      issues.push({
        id: `dead-export:${moduleName}:${exported}`,
        category: 'dead-export',
        severity: 'info',
        title: `${exported} is exported by ${moduleName} but never consumed`,
        description: `${moduleName} lists ${exported} in its exports, but no other module in the graph injects it or re-exports it. The export widens the module's public surface without anything depending on it.`,
        remediation: `Remove ${exported} from the exports array of ${moduleName} to keep the module boundary minimal and the provider encapsulated. Export it again when another module actually needs to inject it.`,
        module: moduleName,
        target: exported
      })
    }
  }

  return issues
}

function collectOrphanModuleIssues(
  graphData: GraphOutput
): ArchitectureIssue[] {
  // Without a root there is nothing to be reachable from.
  if (!graphData.modules[graphData.root]) {
    return []
  }

  const reachable = reachableModules(graphData)
  return moduleEntries(graphData)
    .filter(([moduleName]) => !reachable.has(moduleName))
    .map(([moduleName]) => ({
      id: `orphan-module:${moduleName}`,
      category: 'orphan-module',
      severity: 'warning',
      title: `${moduleName} is not reachable from ${graphData.root}`,
      description: `Following imports from the root module ${graphData.root} never reaches ${moduleName}. A module outside the import tree is either dead code or wired in a way the graph cannot see, so its providers and controllers may not be registered the way you expect.`,
      remediation: `If ${moduleName} is needed, import it into ${graphData.root} or into the feature module that depends on it. If it is obsolete, delete the module and its providers.`,
      module: moduleName,
      relatedModules: [graphData.root]
    }))
}

export function collectArchitectureIssues(
  graphData: GraphOutput | null | undefined
): ArchitectureIssue[] {
  if (!graphData?.modules) {
    return []
  }

  return [
    ...collectCircularIssues(graphData),
    ...collectDuplicateProviderIssues(graphData),
    ...collectUnusedImportIssues(graphData),
    ...collectDeadExportIssues(graphData),
    ...collectOrphanModuleIssues(graphData)
  ].sort(compareArchitectureIssues)
}

export function summarizeArchitectureIssues(
  issues: ArchitectureIssue[]
): ArchitectureIssuesSummary {
  const byCategory = Object.fromEntries(
    ARCHITECTURE_ISSUE_CATEGORIES.map(category => [category, 0])
  ) as Record<ArchitectureIssueCategory, number>
  const summary: ArchitectureIssuesSummary = {
    total: issues.length,
    errors: 0,
    warnings: 0,
    cleanups: 0,
    byCategory
  }

  for (const issue of issues) {
    byCategory[issue.category] += 1
    if (issue.severity === 'error') {
      summary.errors += 1
    } else if (issue.severity === 'warning') {
      summary.warnings += 1
    } else {
      summary.cleanups += 1
    }
  }

  return summary
}
