import { strict as assert } from 'node:assert'
import type {
  GraphOutput,
  GraphOutputCycles,
  GraphOutputDependencyRef
} from 'nest-graph-inspector'
import {
  DEFAULT_TRACE_DEPTH,
  MAX_TRACE_DEPTH,
  createGraphAgentTools,
  describeModule,
  findCycles,
  findProvider,
  listModules,
  searchGraph,
  traceDependencies
} from './graph-agent-tools.ts'

function dependency(moduleName: string, token: string): GraphOutputDependencyRef {
  return { providedBy: { type: 'module', name: moduleName }, token }
}

function noCycles(): GraphOutputCycles {
  return { modules: [], providers: [], controllers: [] }
}

// Shaped after the demo application's own output — the same modules, the same
// wiring and the same two cycles — so what these assertions lock in is what the
// model sees when someone opens the viewer on the demo.
const graph: GraphOutput = {
  version: '3',
  root: 'AppModule',
  modules: {
    AppModule: {
      jsdoc: 'This is playground root module\nthat imports the feature modules.',
      imports: ['UserModule', 'ProductModule', 'OrderModule', 'ConfigHostModule'],
      exports: [],
      providers: [],
      controllers: []
    },
    UserModule: {
      jsdoc: 'UserModule is example feature',
      imports: ['MobileModule', 'ConfigHostModule'],
      exports: ['UserService'],
      providers: [
        {
          name: 'UserService',
          dependencies: [
            dependency('UserModule', 'UserRepository'),
            dependency('MobileModule', 'MobileService')
          ],
          directRun: {
            methods: [
              { name: 'createUser', parameterTypes: '[name: string, email: string]' },
              { name: 'getAllUsers', parameterTypes: '[]' }
            ]
          }
        },
        { name: 'UserRepository', dependencies: [] },
        {
          name: 'UserSchedule',
          jsdoc: 'scheduler for user module',
          dependencies: [dependency('UserModule', 'UserRepository')]
        }
      ],
      controllers: [
        {
          name: 'UserController',
          dependencies: [
            dependency('UserModule', 'UserService'),
            dependency('UserModule', 'UserSchedule')
          ]
        }
      ]
    },
    MobileModule: {
      imports: ['ConfigModule', 'ProductModule', 'ConfigHostModule'],
      exports: ['MobileService'],
      providers: [
        {
          name: 'MobileService',
          dependencies: [
            dependency('ProductModule', 'ProductService'),
            dependency('ConfigModule', 'useFactory')
          ]
        }
      ],
      controllers: []
    },
    ConfigModule: {
      imports: ['ConfigHostModule'],
      exports: ['ConfigHostModule', 'ConfigService'],
      providers: [
        {
          name: 'useFactory',
          dependencies: [dependency('ConfigHostModule', 'ConfigService')]
        }
      ],
      controllers: []
    },
    ConfigHostModule: {
      imports: [],
      exports: ['CONFIGURATION_TOKEN', 'Symbol(CONFIG_SERVICE)'],
      providers: [
        { name: 'useFactory', dependencies: [] },
        {
          name: 'ConfigService',
          dependencies: [dependency('ConfigHostModule', 'useFactory')]
        }
      ],
      controllers: []
    },
    ProductModule: {
      jsdoc: 'ProductModule imports UserModule but does NOT use any of its providers.',
      imports: ['UserModule', 'MobileModule', 'ConfigHostModule'],
      exports: ['ProductService'],
      providers: [
        {
          name: 'ProductService',
          dependencies: [
            dependency('ProductModule', 'ProductRepository'),
            dependency('MobileModule', 'MobileService')
          ]
        },
        { name: 'ProductRepository', dependencies: [] }
      ],
      controllers: [
        {
          name: 'ProductController',
          dependencies: [dependency('ProductModule', 'ProductService')]
        }
      ]
    },
    OrderModule: {
      imports: ['UserModule', 'ProductModule', 'ConfigHostModule'],
      exports: ['OrderService'],
      providers: [
        { name: 'OrderRepository', dependencies: [] },
        {
          name: 'OrderService',
          dependencies: [
            dependency('OrderModule', 'OrderRepository'),
            dependency('UserModule', 'UserService'),
            dependency('ProductModule', 'ProductService'),
            dependency('OrderModule', 'OrderNotificationService')
          ]
        },
        {
          name: 'OrderNotificationService',
          dependencies: [dependency('OrderModule', 'OrderService')]
        }
      ],
      controllers: [
        {
          name: 'OrderController',
          dependencies: [
            dependency('OrderModule', 'OrderService'),
            dependency('NestJSCoreModule', 'ModuleRef'),
            dependency('OrderModule', 'OrderNotificationService')
          ]
        }
      ]
    },
    NestJSCoreModule: {
      imports: [],
      exports: ['ModuleRef'],
      providers: [{ name: 'ModuleRef', dependencies: [] }],
      controllers: []
    }
  },
  cycles: {
    modules: [
      {
        id: 1,
        from: 'UserModule',
        to: 'MobileModule',
        type: 'indirect',
        path: ['UserModule', 'MobileModule', 'ProductModule', 'UserModule']
      },
      {
        id: 2,
        from: 'MobileModule',
        to: 'ProductModule',
        type: 'direct',
        path: ['MobileModule', 'ProductModule', 'MobileModule']
      }
    ],
    providers: [
      {
        id: 3,
        from: 'MobileModule:MobileService',
        to: 'ProductModule:ProductService',
        type: 'direct',
        path: [
          { module: { name: 'MobileModule' }, provider: { name: 'MobileService' } },
          { module: { name: 'ProductModule' }, provider: { name: 'ProductService' } },
          { module: { name: 'MobileModule' }, provider: { name: 'MobileService' } }
        ]
      },
      {
        id: 4,
        from: 'OrderModule:OrderService',
        to: 'OrderModule:OrderNotificationService',
        type: 'direct',
        path: [
          { module: { name: 'OrderModule' }, provider: { name: 'OrderService' } },
          { module: { name: 'OrderModule' }, provider: { name: 'OrderNotificationService' } },
          { module: { name: 'OrderModule' }, provider: { name: 'OrderService' } }
        ]
      }
    ],
    controllers: []
  }
}

// ---------------------------------------------------------------------------
// listModules
// ---------------------------------------------------------------------------

// Emission order, not alphabetical: the root comes first and the ordering is
// something a reader can check against the viewer.
assert.deepEqual(listModules(graph), [
  'AppModule',
  'UserModule',
  'MobileModule',
  'ConfigModule',
  'ConfigHostModule',
  'ProductModule',
  'OrderModule',
  'NestJSCoreModule'
])

assert.deepEqual(listModules(null), [])
assert.deepEqual(listModules(undefined), [])

// ---------------------------------------------------------------------------
// describeModule
// ---------------------------------------------------------------------------

assert.equal(
  describeModule(graph, 'UserModule'),
  [
    'Module UserModule',
    'Doc: UserModule is example feature',
    'Imports (2): MobileModule, ConfigHostModule',
    'Exports (1): UserService',
    'Providers (3): UserService, UserRepository, UserSchedule',
    'Controllers (1): UserController',
    'Imported by (3): AppModule, ProductModule, OrderModule'
  ].join('\n')
)

// The root is called out, and a multi-line JSDoc block is flattened onto one.
assert.equal(
  describeModule(graph, 'AppModule'),
  [
    'Module AppModule (root module)',
    'Doc: This is playground root module that imports the feature modules.',
    'Imports (4): UserModule, ProductModule, OrderModule, ConfigHostModule',
    'Exports (0): none',
    'Providers (0): none',
    'Controllers (0): none',
    'Imported by (0): none'
  ].join('\n')
)

// However the model spells a name, it lands on the same module.
for (const spelling of ['usermodule', 'user_module', '  UserModule  ', 'user-module', 'the user module', 'Usermodul']) {
  assert.equal(
    describeModule(graph, spelling),
    describeModule(graph, 'UserModule'),
    `${JSON.stringify(spelling)} should resolve to UserModule`
  )
}

// A miss is a list to try next, never an exception and never an empty answer.
assert.equal(
  describeModule(graph, 'AccountModule'),
  'No module named "AccountModule". Did you mean: AppModule, ConfigHostModule, ConfigModule, MobileModule, NestJSCoreModule, OrderModule, ProductModule, UserModule?'
)

// A partial that fits several modules is reported as ambiguous rather than
// resolved to whichever one came first.
assert.equal(
  describeModule(graph, 'Config'),
  '"Config" matches 2 names: ConfigModule, ConfigHostModule. Ask again with one of them.'
)

assert.equal(describeModule(null, 'UserModule'), 'No graph is loaded yet, so there is nothing to look up.')

// A name that belongs to the *other* lookup is the commonest mistake a small
// model makes with two tools that both take a name. Answering "no such module"
// would spend a turn teaching it nothing, so the miss names the call that works.
assert.equal(
  describeModule(graph, 'UserService'),
  'UserService is not a module. It is a provider in module UserModule. Call find_provider with "UserService" instead.'
)
assert.equal(
  describeModule(graph, 'OrderController'),
  'OrderController is not a module. It is a controller in module OrderModule. Call find_provider with "OrderController" instead.'
)
assert.equal(
  describeModule(graph, 'useFactory'),
  'useFactory is not a module. It is a provider declared in 2 modules. Call find_provider with "useFactory" instead.'
)
assert.equal(
  describeModule(graph, 'CONFIGURATION_TOKEN'),
  'CONFIGURATION_TOKEN is not a module. It is an injection token with no provider entry. Call find_provider with "CONFIGURATION_TOKEN" instead.'
)

// A JSDoc block long enough to crowd out the answer is clipped, not passed on.
const wordyGraph: GraphOutput = {
  version: '3',
  root: 'AppModule',
  modules: {
    AppModule: {
      jsdoc: `${'word '.repeat(60)}end`,
      imports: [],
      exports: [],
      providers: [],
      controllers: []
    }
  },
  cycles: noCycles()
}

const wordyDoc = describeModule(wordyGraph, 'AppModule').split('\n')[1] || ''
assert.equal(wordyDoc.length, 'Doc: '.length + 160)
assert.ok(wordyDoc.endsWith('…'), 'a clipped doc says so')

// ---------------------------------------------------------------------------
// findProvider
// ---------------------------------------------------------------------------

assert.equal(
  findProvider(graph, 'UserService'),
  [
    'Provider UserService in module UserModule',
    'Depends on (2): UserRepository from UserModule, MobileService from MobileModule',
    'Used by (2): UserController from UserModule, OrderService from OrderModule',
    'Exported by (1): UserModule',
    'Runnable methods (2): createUser, getAllUsers'
  ].join('\n')
)

// Case and spacing are the model's, not the graph's.
assert.equal(findProvider(graph, '  userservice '), findProvider(graph, 'UserService'))
assert.equal(findProvider(graph, 'the user service'), findProvider(graph, 'UserService'))

// A provider's own JSDoc is carried through.
assert.equal(
  findProvider(graph, 'UserSchedule'),
  [
    'Provider UserSchedule in module UserModule',
    'Doc: scheduler for user module',
    'Depends on (1): UserRepository from UserModule',
    'Used by (1): UserController from UserModule',
    'Exported by (0): none'
  ].join('\n')
)

// Controllers answer here too. Sending the model looking for a second tool that
// does not exist is the sort of dead end that makes a small model loop.
assert.equal(
  findProvider(graph, 'UserController'),
  [
    'Controller UserController in module UserModule',
    'Depends on (2): UserService from UserModule, UserSchedule from UserModule'
  ].join('\n')
)

// The same token declared in two modules — `useFactory` is a real duplicate in
// the demo graph. Each occurrence gets its own block, and "used by" is scoped
// to the module that declares it so the two do not blur together.
assert.equal(
  findProvider(graph, 'useFactory'),
  [
    'useFactory is declared in 2 modules: ConfigModule, ConfigHostModule.',
    '',
    'Provider useFactory in module ConfigModule',
    'Depends on (1): ConfigService from ConfigHostModule',
    'Used by (1): MobileService from MobileModule',
    'Exported by (0): none',
    '',
    'Provider useFactory in module ConfigHostModule',
    'Depends on (0): none',
    'Used by (1): ConfigService from ConfigHostModule',
    'Exported by (0): none'
  ].join('\n')
)

// A token that is exported but never declared as a provider. Nest registers
// values and factories under bare strings, so this is an ordinary graph entry
// and the answer has to say what is known rather than nothing at all.
assert.equal(
  findProvider(graph, 'CONFIGURATION_TOKEN'),
  [
    'CONFIGURATION_TOKEN is a token with no provider or controller entry in this graph. It is registered with a value or a factory, or it comes from outside the graph.',
    'Exported by (1): ConfigHostModule',
    'Used by (0): none'
  ].join('\n')
)

// Suggestions are ranked by how much of the question they contain and then by
// how far they agree from the start, which is why ProductService leads a field
// of `*Service` names. The stringified symbol token is in there because it is
// genuinely something this graph can be asked about.
assert.equal(
  findProvider(graph, 'PaymentService'),
  'No provider or controller named "PaymentService". Did you mean: ProductService, ConfigService, MobileService, OrderNotificationService, OrderService, Symbol(CONFIG_SERVICE), UserService, ProductController?'
)

assert.equal(
  findProvider(graph, 'Repository'),
  '"Repository" matches 3 names: UserRepository, ProductRepository, OrderRepository. Ask again with one of them.'
)

assert.equal(findProvider(null, 'UserService'), 'No graph is loaded yet, so there is nothing to look up.')

// The mirror of the redirect above.
assert.equal(
  findProvider(graph, 'OrderModule'),
  'OrderModule is a module, not a provider or a controller. Call describe_module with "OrderModule" instead.'
)

// `exports` is documented as a list of provider tokens, but Nest also lets a
// module re-export an imported module, and ConfigModule does. That entry is a
// module name sitting in a provider list, and it is answered as one.
assert.equal(
  findProvider(graph, 'ConfigHostModule'),
  'ConfigHostModule is a module, re-exported by ConfigModule. Call describe_module with "ConfigHostModule" for what is inside it.'
)

// The same token in more than three modules: three blocks, then a count.
const crowdedGraph: GraphOutput = {
  version: '3',
  root: 'AppModule',
  modules: Object.fromEntries(
    ['AModule', 'BModule', 'CModule', 'DModule'].map(moduleName => [
      moduleName,
      { imports: [], exports: [], providers: [{ name: 'useFactory', dependencies: [] }], controllers: [] }
    ])
  ),
  cycles: noCycles()
}

assert.equal(
  findProvider(crowdedGraph, 'useFactory'),
  [
    'useFactory is declared in 4 modules: AModule, BModule, CModule, DModule.',
    '',
    'Provider useFactory in module AModule',
    'Depends on (0): none',
    'Used by (0): none',
    'Exported by (0): none',
    '',
    'Provider useFactory in module BModule',
    'Depends on (0): none',
    'Used by (0): none',
    'Exported by (0): none',
    '',
    'Provider useFactory in module CModule',
    'Depends on (0): none',
    'Used by (0): none',
    'Exported by (0): none',
    '',
    '... 1 more not shown.'
  ].join('\n')
)

// A graph of nothing but modules still answers with somewhere to go next.
const barrenGraph: GraphOutput = {
  version: '3',
  root: 'AppModule',
  modules: { AppModule: { imports: [], exports: [], providers: [], controllers: [] } },
  cycles: noCycles()
}

assert.equal(
  findProvider(barrenGraph, 'UserService'),
  'This graph declares no providers or controllers. Call list_modules to see what it does have.'
)

// ---------------------------------------------------------------------------
// traceDependencies
// ---------------------------------------------------------------------------

// A diamond and a cycle in one tree. `MobileService` is reached twice and only
// walked once; `OrderNotificationService` closes the loop back onto the root
// and is marked instead of followed.
assert.equal(
  traceDependencies(graph, 'OrderService'),
  [
    'Dependency tree for OrderService from OrderModule (depth limit 3):',
    'OrderService from OrderModule',
    '  OrderRepository from OrderModule (no dependencies)',
    '  UserService from UserModule',
    '    UserRepository from UserModule (no dependencies)',
    '    MobileService from MobileModule',
    '      ProductService from ProductModule (2 dependencies not shown, depth limit reached)',
    '      useFactory from ConfigModule (1 dependency not shown, depth limit reached)',
    '  ProductService from ProductModule',
    '    ProductRepository from ProductModule (no dependencies)',
    '    MobileService from MobileModule (already expanded above)',
    '  OrderNotificationService from OrderModule',
    '    OrderService from OrderModule (circular, already on this path)'
  ].join('\n')
)

// The cross-module cycle MobileService -> ProductService -> MobileService is
// the one the library reports as cycle #3. Walking it at full depth terminates.
assert.equal(
  traceDependencies(graph, 'MobileService', MAX_TRACE_DEPTH),
  [
    'Dependency tree for MobileService from MobileModule (depth limit 6):',
    'MobileService from MobileModule',
    '  ProductService from ProductModule',
    '    ProductRepository from ProductModule (no dependencies)',
    '    MobileService from MobileModule (circular, already on this path)',
    '  useFactory from ConfigModule',
    '    ConfigService from ConfigHostModule',
    '      useFactory from ConfigHostModule (no dependencies)'
  ].join('\n')
)

// Depth is clamped rather than rejected, in both directions.
assert.equal(
  traceDependencies(graph, 'UserService', 99),
  traceDependencies(graph, 'UserService', MAX_TRACE_DEPTH)
)
assert.equal(
  traceDependencies(graph, 'UserService', 0),
  traceDependencies(graph, 'UserService', 1)
)
assert.equal(
  traceDependencies(graph, 'UserService', Number.NaN),
  traceDependencies(graph, 'UserService', DEFAULT_TRACE_DEPTH)
)

assert.equal(
  traceDependencies(graph, 'UserService', 1),
  [
    'Dependency tree for UserService from UserModule (depth limit 1):',
    'UserService from UserModule',
    '  UserRepository from UserModule (no dependencies)',
    '  MobileService from MobileModule (2 dependencies not shown, depth limit reached)'
  ].join('\n')
)

// A controller is a legitimate starting point, and its dependency on a NestJS
// core token resolves through the synthetic `NestJSCoreModule` entry.
assert.equal(
  traceDependencies(graph, 'OrderController', 1),
  [
    'Dependency tree for OrderController from OrderModule (depth limit 1):',
    'OrderController from OrderModule',
    '  OrderService from OrderModule (4 dependencies not shown, depth limit reached)',
    '  ModuleRef from NestJSCoreModule (no dependencies)',
    '  OrderNotificationService from OrderModule (1 dependency not shown, depth limit reached)'
  ].join('\n')
)

// Two declarations, one tree — and the answer says which one it picked so the
// model can ask again for the other.
assert.equal(
  traceDependencies(graph, 'useFactory', 1),
  [
    'useFactory is declared in 2 modules; tracing the one in ConfigModule.',
    'Dependency tree for useFactory from ConfigModule (depth limit 1):',
    'useFactory from ConfigModule',
    '  ConfigService from ConfigHostModule (1 dependency not shown, depth limit reached)'
  ].join('\n')
)

// Tracing only offers names it could actually walk, so the undeclared tokens
// `find_provider` would suggest are absent here.
assert.equal(
  traceDependencies(graph, 'NoSuchService'),
  'No provider or controller named "NoSuchService". Did you mean: ConfigService, MobileService, OrderNotificationService, OrderService, ProductService, UserService?'
)

assert.equal(traceDependencies(null, 'UserService'), 'No graph is loaded yet, so there is nothing to look up.')

// Both of the ways a name can miss this tool and still be a real name.
assert.equal(
  traceDependencies(graph, 'UserModule'),
  'UserModule is a module, not a provider or a controller. Call describe_module with "UserModule" instead.'
)
assert.equal(
  traceDependencies(graph, 'CONFIGURATION_TOKEN'),
  'CONFIGURATION_TOKEN has no dependencies to walk — it is an injection token with no provider entry in this graph. Call find_provider with "CONFIGURATION_TOKEN" instead.'
)

// An exactly-spelled name has to beat a fuzzy one, or a longer token swallows a
// shorter provider whose name it contains. `Symbol(CONFIG_SERVICE)` normalizes
// to something ending in `configservice`, and the rule that lets "the user
// service" find UserService would otherwise answer this with ConfigService's
// tree — the wrong answer, stated confidently.
assert.equal(
  traceDependencies(graph, 'Symbol(CONFIG_SERVICE)'),
  'Symbol(CONFIG_SERVICE) has no dependencies to walk — it is an injection token with no provider entry in this graph. Call find_provider with "Symbol(CONFIG_SERVICE)" instead.'
)
assert.equal(
  findProvider(graph, 'Symbol(CONFIG_SERVICE)').split('\n')[0],
  'Symbol(CONFIG_SERVICE) is a token with no provider or controller entry in this graph. It is registered with a value or a factory, or it comes from outside the graph.'
)

// A module re-exported as if it were a provider token reaches this tool too, and
// is sent to the module lookup rather than called an injection token.
assert.equal(
  traceDependencies(graph, 'ConfigHostModule'),
  'ConfigHostModule is a module, not a provider or a controller. Call describe_module with "ConfigHostModule" instead.'
)

// Fuzzy still resolves when nothing is spelled exactly.
assert.equal(traceDependencies(graph, ' the order service '), traceDependencies(graph, 'OrderService'))

assert.equal(
  traceDependencies(barrenGraph, 'UserService'),
  'This graph has no providers or controllers to trace.'
)

// A dependency the graph never describes is named as such rather than dropped,
// and a provider that injects itself terminates on the first repeat.
const danglingGraph: GraphOutput = {
  version: '3',
  root: 'AppModule',
  modules: {
    AppModule: {
      imports: [],
      exports: [],
      providers: [
        { name: 'SelfService', dependencies: [dependency('AppModule', 'SelfService')] },
        { name: 'LooseService', dependencies: [dependency('GhostModule', 'GhostToken')] }
      ],
      controllers: []
    }
  },
  cycles: noCycles()
}

assert.equal(
  traceDependencies(danglingGraph, 'SelfService'),
  [
    'Dependency tree for SelfService from AppModule (depth limit 3):',
    'SelfService from AppModule',
    '  SelfService from AppModule (circular, already on this path)'
  ].join('\n')
)

assert.equal(
  traceDependencies(danglingGraph, 'LooseService'),
  [
    'Dependency tree for LooseService from AppModule (depth limit 3):',
    'LooseService from AppModule',
    '  GhostToken from GhostModule (not declared in this graph)'
  ].join('\n')
)

// ---------------------------------------------------------------------------
// findCycles
// ---------------------------------------------------------------------------

assert.equal(
  findCycles(graph),
  [
    '4 circular dependencies: 2 module, 2 provider, 0 controller.',
    '#1 module, indirect: UserModule -> MobileModule -> ProductModule -> UserModule',
    '#2 module, direct: MobileModule -> ProductModule -> MobileModule',
    '#3 provider, direct: MobileService from MobileModule -> ProductService from ProductModule -> MobileService from MobileModule',
    '#4 provider, direct: OrderService from OrderModule -> OrderNotificationService from OrderModule -> OrderService from OrderModule'
  ].join('\n')
)

// The composite `Module:Provider` keys a controller cycle uses are decoded, not
// echoed — the graph contract spells controller paths differently from the
// provider paths right next to them.
const controllerCycleGraph: GraphOutput = {
  version: '3',
  root: 'AppModule',
  modules: { AppModule: { imports: [], exports: [], providers: [], controllers: [] } },
  cycles: {
    modules: [],
    providers: [],
    controllers: [
      {
        id: 7,
        from: 'AppModule:AController',
        to: 'AppModule:BController',
        type: 'direct',
        path: ['AppModule:AController', 'AppModule:BController', 'AppModule:AController']
      }
    ]
  }
}

assert.equal(
  findCycles(controllerCycleGraph),
  [
    '1 circular dependency: 0 module, 0 provider, 1 controller.',
    '#7 controller, direct: AController from AppModule -> BController from AppModule -> AController from AppModule'
  ].join('\n')
)

assert.equal(
  findCycles({ ...graph, cycles: noCycles() }),
  'No circular dependencies were found in this graph.'
)

assert.equal(findCycles(undefined), 'No graph is loaded yet, so there is nothing to look up.')

// A tangled application reports more cycles than the model can usefully read,
// and a single cycle can be longer than the graph is wide. Both are capped, and
// both say what they are holding back.
const tangledGraph: GraphOutput = {
  version: '3',
  root: 'AppModule',
  modules: { AppModule: { imports: [], exports: [], providers: [], controllers: [] } },
  cycles: {
    modules: Array.from({ length: 20 }, (_unused, index) => ({
      id: index + 1,
      from: `M${index}`,
      to: `M${index + 1}`,
      type: 'direct' as const,
      path: [`M${index}`, `M${index + 1}`, `M${index}`]
    })),
    providers: [],
    controllers: []
  }
}

const tangled = findCycles(tangledGraph).split('\n')
assert.equal(tangled[0], '20 circular dependencies: 20 module, 0 provider, 0 controller.')
assert.equal(tangled.length, 17)
assert.equal(tangled.at(-1), '... and 5 more.')

const longCycleGraph: GraphOutput = {
  version: '3',
  root: 'AppModule',
  modules: { AppModule: { imports: [], exports: [], providers: [], controllers: [] } },
  cycles: {
    modules: [
      {
        id: 1,
        from: 'M0',
        to: 'M1',
        type: 'indirect',
        path: Array.from({ length: 20 }, (_unused, index) => `M${index}`)
      }
    ],
    providers: [],
    controllers: []
  }
}

assert.equal(
  findCycles(longCycleGraph).split('\n')[1],
  '#1 module, indirect: M0 -> M1 -> M2 -> M3 -> M4 -> M5 -> M6 -> M7 -> M8 -> M9 -> M10 -> M11 -> ... (20 nodes in total)'
)

// The contract promises three arrays. JSON off the wire promises nothing, and
// an agent loop is the wrong place to discover a missing one: a throw leaves the
// model with no result to reason about, so it repeats the call.
function graphWithPartialCycles(partial: Partial<GraphOutputCycles>): GraphOutput {
  return {
    version: '3',
    root: 'AppModule',
    modules: { AppModule: { imports: [], exports: [], providers: [], controllers: [] } },
    cycles: partial as GraphOutputCycles
  }
}

assert.equal(
  findCycles(graphWithPartialCycles({})),
  'No circular dependencies were found in this graph.'
)
assert.equal(
  findCycles(graphWithPartialCycles({
    providers: [
      {
        id: 9,
        from: 'AppModule:A',
        to: 'AppModule:B',
        type: 'direct',
        path: [
          { module: { name: 'AppModule' }, provider: { name: 'A' } },
          { module: { name: 'AppModule' }, provider: { name: 'B' } },
          { module: { name: 'AppModule' }, provider: { name: 'A' } }
        ]
      }
    ]
  })),
  [
    '1 circular dependency: 0 module, 1 provider, 0 controller.',
    '#9 provider, direct: A from AppModule -> B from AppModule -> A from AppModule'
  ].join('\n')
)

// ---------------------------------------------------------------------------
// searchGraph
// ---------------------------------------------------------------------------

// Name matches first, doc mentions after: the first group answers the question,
// the second only explains it. ProductModule's comment names UserModule.
assert.equal(
  searchGraph(graph, 'user'),
  [
    '6 matches for "user":',
    'module UserModule',
    'provider UserService from UserModule',
    'provider UserRepository from UserModule',
    'provider UserSchedule from UserModule',
    'controller UserController from UserModule',
    'module ProductModule (doc mention)'
  ].join('\n')
)

// A re-export is not repeated as a loose token — ConfigModule re-exports
// ConfigService and ConfigHostModule, both of which are already listed. What
// survives is what exists nowhere else, including the stringified symbol token.
assert.equal(
  searchGraph(graph, 'config'),
  [
    '5 matches for "config":',
    'module ConfigModule',
    'module ConfigHostModule',
    'provider ConfigService from ConfigHostModule',
    'token CONFIGURATION_TOKEN exported by ConfigHostModule',
    'token Symbol(CONFIG_SERVICE) exported by ConfigHostModule'
  ].join('\n')
)

// Case and stray spacing change nothing but the header, which quotes the query
// back as the model wrote it.
assert.deepEqual(
  searchGraph(graph, 'ORDER').split('\n').slice(1),
  searchGraph(graph, ' order ').split('\n').slice(1)
)
assert.equal(searchGraph(graph, 'ORDER').split('\n')[0], '5 matches for "ORDER":')
assert.equal(searchGraph(graph, ' order ').split('\n')[0], '5 matches for "order":')

assert.equal(
  searchGraph(graph, 'nothinglikethis'),
  'Nothing in the graph matches "nothinglikethis". Call list_modules to see what is there.'
)

assert.equal(
  searchGraph(graph, '   '),
  'Give search_graph a word to look for, such as part of a module or provider name.'
)

assert.equal(searchGraph(null, 'user'), 'No graph is loaded yet, so there is nothing to look up.')

// ---------------------------------------------------------------------------
// Capping — a real graph is far larger than the demo's eight modules, and the
// window the model is reading into is 4096 tokens whatever the graph costs.
// ---------------------------------------------------------------------------

function buildWideGraph(featureCount: number): GraphOutput {
  const featureNames = Array.from(
    { length: featureCount },
    (_unused, index) => `FeatureModule${index + 1}`
  )

  const modules: GraphOutput['modules'] = {
    AppModule: { imports: featureNames, exports: [], providers: [], controllers: [] }
  }

  for (let index = 1; index <= featureCount; index += 1) {
    modules[`FeatureModule${index}`] = {
      imports: [],
      exports: [],
      providers: [{ name: `FeatureService${index}`, dependencies: [] }],
      controllers: []
    }
  }

  return { version: '3', root: 'AppModule', modules, cycles: noCycles() }
}

const wideGraph = buildWideGraph(50)

assert.equal(listModules(wideGraph).length, 51)

// 100 names match, 25 are shown, and the answer says how much it is holding
// back so the model knows the list is not the whole story.
const wideSearch = searchGraph(wideGraph, 'feature')
assert.equal(wideSearch.split('\n')[0], '100 matches for "feature":')
assert.equal(wideSearch.split('\n').length, 27)
assert.equal(wideSearch.split('\n').at(-1), '... and 75 more.')

// An inline name list is capped the same way: 50 imports, 40 named.
const wideImports = describeModule(wideGraph, 'AppModule').split('\n')[1] || ''
assert.match(wideImports, /^Imports \(50\): FeatureModule1, FeatureModule2, /)
assert.match(wideImports, /FeatureModule40, and 10 more$/)

// An empty name is a miss like any other, and answers with somewhere to start
// rather than with nothing.
assert.equal(
  describeModule(wideGraph, ''),
  'No module named "". Did you mean: AppModule, FeatureModule1, FeatureModule2, FeatureModule3, FeatureModule4, FeatureModule5, FeatureModule6, FeatureModule7?'
)

const fanOutGraph: GraphOutput = {
  version: '3',
  root: 'AppModule',
  modules: {
    AppModule: {
      imports: [],
      exports: [],
      providers: [
        {
          name: 'HubService',
          dependencies: Array.from({ length: 60 }, (_unused, index) =>
            dependency('AppModule', `LeafService${index}`)
          )
        },
        ...Array.from({ length: 60 }, (_unused, index) => ({
          name: `LeafService${index}`,
          dependencies: []
        }))
      ],
      controllers: []
    }
  },
  cycles: noCycles()
}

const fanOutTree = traceDependencies(fanOutGraph, 'HubService')
assert.equal(fanOutTree.split('\n').length, 42)
assert.equal(
  fanOutTree.split('\n').at(-1),
  '... tree truncated at 40 lines, ask about one branch instead.'
)

// ---------------------------------------------------------------------------
// The LangChain layer
// ---------------------------------------------------------------------------

const tools = await createGraphAgentTools(graph)

assert.deepEqual(
  tools.map(agentTool => agentTool.name),
  [
    'list_modules',
    'describe_module',
    'find_provider',
    'trace_dependencies',
    'find_cycles',
    'search_graph'
  ]
)

// The descriptions are the whole of what the agent has to go on when it picks,
// and they are charged against a 4096-token window every turn. Long enough to
// distinguish a tool from its neighbour, short enough not to crowd out the
// answer — and never two the same, which is a pick decided by nothing.
const descriptions = tools.map(agentTool => agentTool.description || '')

for (const [index, description] of descriptions.entries()) {
  const name = tools[index]?.name
  assert.ok(description.length > 20, `${name} needs a description the model can choose on`)
  assert.ok(description.length <= 280, `${name} spends too much of the window on its description`)
}

assert.equal(new Set(descriptions).size, descriptions.length, 'two tools must never read alike')
assert.equal(new Set(tools.map(agentTool => agentTool.name)).size, tools.length)

// Several descriptions steer the model to a sibling by name. A rename that left
// one of those behind would be a prompt pointing at a tool that does not exist.
const toolNames = new Set(tools.map(agentTool => agentTool.name))

for (const [index, description] of descriptions.entries()) {
  for (const referenced of description.match(/\b[a-z]+(?:_[a-z]+)+\b/g) || []) {
    assert.ok(
      toolNames.has(referenced) && referenced !== tools[index]?.name,
      `${tools[index]?.name} points at "${referenced}", which is not another tool`
    )
  }
}

const byName = new Map(tools.map(agentTool => [agentTool.name, agentTool]))

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const agentTool = byName.get(name)

  if (!agentTool) {
    throw new Error(`${name} should exist`)
  }

  const result: unknown = await agentTool.invoke(args)
  assert.equal(typeof result, 'string', `${name} should answer with text, not a structure`)

  return String(result)
}

assert.equal(
  await callTool('list_modules', {}),
  '8 modules, root module AppModule: AppModule, UserModule, MobileModule, ConfigModule, ConfigHostModule, ProductModule, OrderModule, NestJSCoreModule'
)

assert.equal(await callTool('describe_module', { name: 'UserModule' }), describeModule(graph, 'UserModule'))
assert.equal(await callTool('find_provider', { name: 'UserService' }), findProvider(graph, 'UserService'))
assert.equal(await callTool('find_cycles', {}), findCycles(graph))
assert.equal(await callTool('search_graph', { query: 'user' }), searchGraph(graph, 'user'))

// A model that writes the depth as a string gets the depth it asked for.
assert.equal(
  await callTool('trace_dependencies', { name: 'OrderService', maxDepth: '1' }),
  traceDependencies(graph, 'OrderService', 1)
)

// Nothing a model can put in a tool call turns into a `ToolInputParsingException`.
// The loop only recovers from results, and an exception is not one.
assert.equal(
  await callTool('describe_module', {}),
  describeModule(graph, '')
)
assert.equal(
  await callTool('find_provider', { name: 42 }),
  findProvider(graph, '')
)
assert.equal(
  await callTool('trace_dependencies', { name: 'UserService', maxDepth: 'deep' }),
  traceDependencies(graph, 'UserService', DEFAULT_TRACE_DEPTH)
)
assert.equal(
  await callTool('search_graph', { wrongKey: 'user' }),
  searchGraph(graph, '')
)

console.log('graph-agent-tools.test.ts ok')
