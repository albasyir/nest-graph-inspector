import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import type {
  GraphOutput,
  GraphOutputCycles,
  GraphOutputDependencyRef,
  GraphOutputModule
} from 'nest-graph-inspector'
import {
  ARCHITECTURE_ISSUE_CATEGORIES,
  NEST_CORE_MODULE_NAME,
  architectureIssueCategoryLabel,
  collectArchitectureIssues,
  summarizeArchitectureIssues
} from './architecture-issues.ts'
import type {
  ArchitectureIssue,
  ArchitectureIssueCategory
} from './architecture-issues.ts'

function dependency(moduleName: string, token: string): GraphOutputDependencyRef {
  return { providedBy: { type: 'module', name: moduleName }, token }
}

function module(overrides: Partial<GraphOutputModule> = {}): GraphOutputModule {
  return {
    imports: [],
    exports: [],
    providers: [],
    controllers: [],
    ...overrides
  }
}

function emptyCycles(): GraphOutputCycles {
  return { modules: [], providers: [], controllers: [] }
}

function graph(
  modules: Record<string, GraphOutputModule>,
  cycles: GraphOutputCycles = emptyCycles(),
  root = 'AppModule'
): GraphOutput {
  return { version: '3', root, modules, cycles }
}

/**
 * AppModule → UserModule → SharedModule; every import is injected through and
 * every export consumed.
 */
function healthyGraph(): GraphOutput {
  return graph({
    AppModule: module({ imports: ['UserModule'] }),
    UserModule: module({
      imports: ['SharedModule'],
      providers: [
        { name: 'UserService', dependencies: [dependency('SharedModule', 'LoggerService')] }
      ],
      controllers: [
        { name: 'UserController', dependencies: [dependency('UserModule', 'UserService')] }
      ]
    }),
    SharedModule: module({
      exports: ['LoggerService'],
      providers: [{ name: 'LoggerService', dependencies: [] }]
    })
  })
}

function ofCategory(
  issues: ArchitectureIssue[],
  category: ArchitectureIssueCategory
): ArchitectureIssue[] {
  return issues.filter(issue => issue.category === category)
}

describe('collectArchitectureIssues', () => {
  test('a missing graph has no issues', () => {
    assert.deepEqual(collectArchitectureIssues(null), [])
    assert.deepEqual(collectArchitectureIssues(undefined), [])
  })

  test('an empty graph has no issues', () => {
    assert.deepEqual(collectArchitectureIssues(graph({})), [])
    assert.deepEqual(
      collectArchitectureIssues(graph({ AppModule: module() })),
      []
    )
  })

  test('a healthy graph has no issues', () => {
    assert.deepEqual(collectArchitectureIssues(healthyGraph()), [])
  })

  describe('circular dependencies', () => {
    test('each cycle the library reported is an error carrying its cycle', () => {
      const data = healthyGraph()
      data.cycles.modules.push({
        id: 1,
        from: 'UserModule',
        to: 'SharedModule',
        type: 'indirect',
        path: ['UserModule', 'SharedModule', 'UserModule']
      })
      data.cycles.providers.push({
        id: 2,
        from: 'UserService',
        to: 'LoggerService',
        type: 'direct',
        path: [
          { module: { name: 'UserModule' }, provider: { name: 'UserService' } },
          { module: { name: 'SharedModule' }, provider: { name: 'LoggerService' } },
          { module: { name: 'UserModule' }, provider: { name: 'UserService' } }
        ]
      })

      const issues = ofCategory(collectArchitectureIssues(data), 'circular')

      assert.equal(issues.length, 2)
      for (const issue of issues) {
        assert.equal(issue.severity, 'error')
        assert.equal(issue.module, 'UserModule')
        assert.deepEqual(issue.relatedModules, ['SharedModule'])
        assert.ok(issue.circularIssue)
        assert.ok(issue.remediation.length > 0)
      }

      const providerIssue = issues.find(
        issue => issue.circularIssue?.category === 'provider'
      )
      assert.equal(providerIssue?.id, 'circular:provider:2')
      assert.deepEqual(providerIssue?.circularIssue?.path, [
        'UserService from UserModule',
        'LoggerService from SharedModule',
        'UserService from UserModule'
      ])
    })
  })

  describe('duplicate provider registration', () => {
    test('a provider registered in several modules is one error naming all of them', () => {
      const data = healthyGraph()
      data.modules.UserModule?.providers.push({ name: 'LoggerService', dependencies: [] })
      data.modules.AppModule?.providers.push({ name: 'LoggerService', dependencies: [] })

      const issues = ofCategory(
        collectArchitectureIssues(data),
        'duplicate-provider'
      )

      assert.equal(issues.length, 1)
      assert.equal(issues[0]?.severity, 'error')
      assert.equal(issues[0]?.target, 'LoggerService')
      assert.equal(issues[0]?.module, 'AppModule')
      assert.deepEqual(issues[0]?.relatedModules, ['SharedModule', 'UserModule'])
      assert.match(issues[0]?.remediation ?? '', /exports/)
    })

    test('the virtual NestJS core module never duplicates a provider', () => {
      const data = healthyGraph()
      data.modules[NEST_CORE_MODULE_NAME] = module({
        providers: [{ name: 'LoggerService', dependencies: [] }]
      })

      assert.deepEqual(
        ofCategory(collectArchitectureIssues(data), 'duplicate-provider'),
        []
      )
    })
  })

  describe('unused module imports', () => {
    function graphWithExtraImport(): GraphOutput {
      const data = healthyGraph()
      data.modules.AppModule?.imports.push('ProductModule')
      data.modules.ProductModule = module({
        imports: ['SharedModule', 'UserModule'],
        providers: [
          {
            name: 'ProductService',
            dependencies: [dependency('SharedModule', 'LoggerService')]
          }
        ]
      })
      return data
    }

    test('an import nothing injects from is a warning on the importer', () => {
      const issues = ofCategory(
        collectArchitectureIssues(graphWithExtraImport()),
        'unused-import'
      )

      assert.equal(issues.length, 1)
      assert.equal(issues[0]?.id, 'unused-import:ProductModule:UserModule')
      assert.equal(issues[0]?.severity, 'warning')
      assert.equal(issues[0]?.module, 'ProductModule')
      assert.equal(issues[0]?.target, 'UserModule')
    })

    test('a controller injecting an exported token uses the import', () => {
      const data = graphWithExtraImport()
      data.modules.UserModule?.exports.push('UserService')
      data.modules.ProductModule?.controllers.push({
        name: 'ProductController',
        dependencies: [dependency('UserModule', 'UserService')]
      })

      assert.deepEqual(
        ofCategory(collectArchitectureIssues(data), 'unused-import'),
        []
      )
    })

    test('re-exporting the imported module uses the import', () => {
      const data = graphWithExtraImport()
      data.modules.ProductModule?.exports.push('UserModule')

      assert.deepEqual(
        ofCategory(collectArchitectureIssues(data), 'unused-import'),
        []
      )
    })

    test('the root module composes the application, so its imports are never unused', () => {
      const data = healthyGraph()
      data.modules.AppModule?.imports.push('SharedModule')

      assert.deepEqual(
        ofCategory(collectArchitectureIssues(data), 'unused-import'),
        []
      )
    })

    test('an import that is the only path from the root registers the module', () => {
      const data = healthyGraph()
      data.modules.UserModule?.imports.push('JobsModule')
      data.modules.JobsModule = module({
        providers: [{ name: 'JobsScheduler', dependencies: [] }]
      })

      assert.deepEqual(
        ofCategory(collectArchitectureIssues(data), 'unused-import'),
        []
      )
    })
  })

  describe('dead exports', () => {
    test('an export no other module injects is a cleanup', () => {
      const data = healthyGraph()
      // UserController injects UserService, but from inside UserModule itself.
      data.modules.UserModule?.exports.push('UserService')

      const issues = ofCategory(collectArchitectureIssues(data), 'dead-export')

      assert.equal(issues.length, 1)
      assert.equal(issues[0]?.id, 'dead-export:UserModule:UserService')
      assert.equal(issues[0]?.severity, 'info')
      assert.equal(issues[0]?.module, 'UserModule')
      assert.equal(issues[0]?.target, 'UserService')
    })

    test('a module that re-exports the token consumes it', () => {
      const data = healthyGraph()
      data.modules.UserModule?.exports.push('LoggerService')

      const issues = ofCategory(collectArchitectureIssues(data), 'dead-export')

      // SharedModule's export is passed on; UserModule's re-export is not consumed.
      assert.deepEqual(
        issues.map(issue => issue.id),
        ['dead-export:UserModule:LoggerService']
      )
    })

    test('an exported module name is a re-export, not a provider token', () => {
      const data = healthyGraph()
      data.modules.UserModule?.exports.push('SharedModule')

      assert.deepEqual(
        ofCategory(collectArchitectureIssues(data), 'dead-export'),
        []
      )
    })
  })

  describe('disconnected modules', () => {
    test('a module no import path reaches from the root is a warning', () => {
      const data = healthyGraph()
      data.modules.LegacyModule = module({ imports: ['SharedModule'] })

      const issues = collectArchitectureIssues(data)

      // Its unused import of SharedModule is moot while it is disconnected.
      assert.equal(issues.length, 1)
      assert.equal(issues[0]?.id, 'orphan-module:LegacyModule')
      assert.equal(issues[0]?.category, 'orphan-module')
      assert.equal(issues[0]?.severity, 'warning')
      assert.deepEqual(issues[0]?.relatedModules, ['AppModule'])
    })

    test('the virtual NestJS core module is never disconnected', () => {
      const data = healthyGraph()
      data.modules[NEST_CORE_MODULE_NAME] = module({
        exports: ['Reflector'],
        providers: [{ name: 'Reflector', dependencies: [] }]
      })
      data.modules.UserModule?.providers[0]?.dependencies.push(
        dependency(NEST_CORE_MODULE_NAME, 'Reflector')
      )

      assert.deepEqual(collectArchitectureIssues(data), [])
    })

    test('a root missing from the modules reports no disconnected modules', () => {
      const data = healthyGraph()
      data.root = 'MissingModule'

      assert.deepEqual(
        ofCategory(collectArchitectureIssues(data), 'orphan-module'),
        []
      )
    })
  })

  test('issues are ordered by severity, then category, then module', () => {
    const data = healthyGraph()
    data.modules.LegacyModule = module()
    data.modules.UserModule?.exports.push('UserService')
    data.modules.AppModule?.providers.push({ name: 'LoggerService', dependencies: [] })
    data.cycles.modules.push({
      id: 7,
      from: 'UserModule',
      to: 'SharedModule',
      type: 'indirect',
      path: ['UserModule', 'SharedModule', 'UserModule']
    })

    const issues = collectArchitectureIssues(data)

    assert.deepEqual(
      issues.map(issue => issue.id),
      [
        'circular:module:7',
        'duplicate-provider:LoggerService',
        'orphan-module:LegacyModule',
        'dead-export:UserModule:UserService'
      ]
    )
    assert.deepEqual(collectArchitectureIssues(data), issues)
  })
})

describe('summarizeArchitectureIssues', () => {
  test('no issues summarise to zeros in every category', () => {
    const summary = summarizeArchitectureIssues([])

    assert.equal(summary.total, 0)
    assert.equal(summary.errors, 0)
    assert.equal(summary.warnings, 0)
    assert.equal(summary.cleanups, 0)
    assert.deepEqual(
      Object.keys(summary.byCategory),
      [...ARCHITECTURE_ISSUE_CATEGORIES]
    )
    assert.ok(Object.values(summary.byCategory).every(count => count === 0))
  })

  test('counts by severity and by category', () => {
    const data = healthyGraph()
    data.modules.LegacyModule = module()
    data.modules.OldModule = module()
    data.modules.UserModule?.exports.push('UserService')

    const summary = summarizeArchitectureIssues(collectArchitectureIssues(data))

    assert.equal(summary.total, 3)
    assert.equal(summary.errors, 0)
    assert.equal(summary.warnings, 2)
    assert.equal(summary.cleanups, 1)
    assert.equal(summary.byCategory['orphan-module'], 2)
    assert.equal(summary.byCategory['dead-export'], 1)
    assert.equal(summary.byCategory.circular, 0)
  })

  test('every category has a label', () => {
    for (const category of ARCHITECTURE_ISSUE_CATEGORIES) {
      assert.ok(architectureIssueCategoryLabel[category])
    }
  })
})
