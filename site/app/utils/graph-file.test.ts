import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  MAX_GRAPH_FILE_BYTES,
  checkGraphFileSize,
  formatFileSize,
  readGraphFileText,
  readGraphOutput,
  type GraphFileResult
} from './graph-file.ts'

const FILE = 'graph.json'

/** The smallest graph the viewer draws: a root module and nothing in it. */
function graph(overrides: Record<string, unknown> = {}) {
  return {
    version: '3',
    root: 'AppModule',
    modules: {
      AppModule: {
        imports: ['UserModule'],
        exports: [],
        providers: [
          {
            name: 'AppService',
            jsdoc: 'The application.',
            dependencies: [
              { token: 'UserService', providedBy: { name: 'UserModule' } }
            ],
            directRun: {
              methods: [{ name: 'hello', parameterTypes: '[]' }]
            }
          }
        ],
        controllers: [{ name: 'AppController', dependencies: [] }]
      },
      UserModule: {
        imports: [],
        exports: ['UserService'],
        providers: [{ name: 'UserService', dependencies: [] }],
        controllers: []
      }
    },
    cycles: { modules: [], providers: [], controllers: [] },
    ...overrides
  }
}

function failure(result: GraphFileResult) {
  assert.equal(result.ok, false, JSON.stringify(result))
  return result as Extract<GraphFileResult, { ok: false }>
}

describe('a graph file', () => {
  test('opens when it is a graph the viewer draws', () => {
    const value = graph()
    const result = readGraphFileText(JSON.stringify(value), FILE)

    assert.equal(result.ok, true)
    assert.equal('notice' in result, false)
    assert.deepEqual(JSON.parse(JSON.stringify(result.ok && result.graph)), value)
  })

  // Module names are the file's to choose. A lookup of one that names nothing
  // has to miss, even when it is the name of something every object inherits.
  test('has modules no inherited name can look up', () => {
    const value = graph()
    value.modules.AppModule.imports = ['toString', 'constructor', '__proto__', 'UserModule']
    const result = readGraphOutput(JSON.parse(JSON.stringify(value)), FILE)

    assert.equal(result.ok, true)
    const { modules } = (result as Extract<GraphFileResult, { ok: true }>).graph
    assert.equal(Object.getPrototypeOf(modules), null)
    for (const name of ['toString', 'constructor', 'hasOwnProperty']) {
      assert.equal((modules as Record<string, unknown>)[name], undefined, name)
    }
    assert.deepEqual(Object.keys(modules), ['AppModule', 'UserModule'])
  })

  test('opens with cycles of every kind', () => {
    const value = graph({
      cycles: {
        modules: [{ id: 1, from: 'AppModule', to: 'UserModule', type: 'indirect', path: ['AppModule', 'UserModule', 'AppModule'] }],
        providers: [{
          id: 2,
          from: 'AppService',
          to: 'UserService',
          type: 'direct',
          path: [
            { module: { name: 'AppModule' }, provider: { name: 'AppService' } },
            { module: { name: 'UserModule' }, provider: { name: 'UserService' } }
          ]
        }],
        controllers: [{ id: 3, from: 'AppController', to: 'AppService', type: 'direct', path: ['AppModule:AppController', 'AppModule:AppService'] }]
      }
    })

    assert.equal(readGraphOutput(value, FILE).ok, true)
  })

  // What `export --compact`, the `json` output and `/output.json` write is the
  // same document; the version arrives as a string, or as a number if edited.
  test('opens with a numeric version, and with whitespace around it', () => {
    assert.equal(readGraphFileText(`\n  ${JSON.stringify(graph({ version: 3 }))}\n`, FILE).ok, true)
  })

  test('is refused before it is read when it is too large', () => {
    assert.equal(checkGraphFileSize(FILE, MAX_GRAPH_FILE_BYTES), undefined)

    const tooLarge = checkGraphFileSize(FILE, MAX_GRAPH_FILE_BYTES + 1)
    assert.equal(tooLarge?.problem, 'too-large')
    assert.equal(tooLarge?.message, 'graph.json is 20 MB. The viewer opens graph files up to 20 MB.')
    assert.equal(
      checkGraphFileSize('huge.json', 3 * 1024 ** 3)?.message,
      'huge.json is 3,072 MB. The viewer opens graph files up to 20 MB.'
    )
  })

  test('that is empty says so', () => {
    for (const text of ['', '   \n']) {
      const result = failure(readGraphFileText(text, FILE))

      assert.equal(result.problem, 'empty')
      assert.match(result.message, /^graph\.json is empty\. Export it again with npx nest-graph-inspector export\.$/)
    }
  })

  test('that is not JSON says where the parser stopped', () => {
    const result = failure(readGraphFileText('{"version": "3",', 'broken.json'))

    assert.equal(result.problem, 'invalid-json')
    assert.match(result.message, /^broken\.json is not valid JSON: .+\.$/)
  })

  test('that is JSON but not an object is not a graph', () => {
    for (const text of ['[]', '"graph"', '3', 'null']) {
      const result = failure(readGraphFileText(text, FILE))

      assert.equal(result.problem, 'not-a-graph', text)
      assert.match(result.message, /it holds no JSON object/)
    }
  })

  // A layout file, or the inspector's information.json, opened by mistake.
  test('without a format version is not a graph', () => {
    for (const value of [{ for: 'nest-graph-inspector' }, { version: null, root: 'AppModule' }]) {
      const result = failure(readGraphOutput(value, 'layout.json'))

      assert.equal(result.problem, 'not-a-graph')
      assert.equal(
        result.message,
        'layout.json is not a Nest Graph Inspector graph: it has no format `version`. Export it again with npx nest-graph-inspector export.'
      )
    }
  })

  // The contract writes a whole number. Its leading digits are not a version.
  test('with a format version that is not a whole number is not a graph', () => {
    for (const version of ['latest', '3garbage', '3.9', ' 3', '', '-3', 3.5, -3, true, ['3']]) {
      const result = failure(readGraphOutput(graph({ version }), FILE))

      assert.equal(result.problem, 'not-a-graph', JSON.stringify(version))
      assert.match(result.message, /its format `version` is not a whole number/)
    }
  })

  test('in a format older than the viewer reads asks for a newer library', () => {
    for (const version of ['1', 2]) {
      const result = failure(readGraphOutput(graph({ version }), 'old.json'))

      assert.equal(result.problem, 'unsupported-version')
      assert.equal(
        result.message,
        `old.json is a version ${version} graph, and the viewer reads version 3 and later. Export it again with a current nest-graph-inspector.`
      )
    }
  })

  // Matches the endpoint path: a newer graph renders, and the viewer says it may
  // be missing what it does not know about.
  test('in a format newer than the viewer opens with a notice', () => {
    const result = readGraphOutput(graph({ version: '4' }), FILE)

    assert.equal(result.ok, true)
    assert.equal(
      result.ok && result.notice,
      'This graph is in format 4, newer than the format 3 this viewer was built for. If anything looks missing, reload the page for the newest viewer.'
    )
    assert.equal('notice' in readGraphOutput(graph(), FILE), false)
  })

  // Its shape may have changed with its format, so the advice is a newer
  // viewer rather than another export.
  test('in a newer format the viewer cannot draw asks for a newer viewer', () => {
    const result = failure(readGraphOutput(graph({ version: '4', modules: [] }), 'next.json'))

    assert.equal(result.problem, 'unsupported-version')
    assert.equal(
      result.message,
      'next.json is in format 4, newer than the format 3 this viewer reads, and this viewer cannot draw it: `modules` is not an object of modules. Reload the page for the newest viewer.'
    )
  })

  test('names the first field the viewer could not read', () => {
    const base = graph()
    const appModule = base.modules.AppModule
    const cases: [unknown, string][] = [
      [graph({ root: '' }), 'it names no `root` module'],
      [graph({ root: 'MissingModule' }), 'its root module, MissingModule, is not among its `modules`'],
      [graph({ modules: [] }), '`modules` is not an object of modules'],
      [graph({ modules: { AppModule: 'module' } }), '`modules.AppModule` is not a module'],
      [graph({ modules: { AppModule: { ...appModule, imports: [1] } } }), '`modules.AppModule.imports` is not a list of names'],
      [graph({ modules: { AppModule: { ...appModule, exports: undefined } } }), '`modules.AppModule.exports` is not a list of names'],
      [graph({ modules: { AppModule: { ...appModule, controllers: {} } } }), '`modules.AppModule.controllers` is not a list'],
      [graph({ modules: { AppModule: { ...appModule, providers: [{ dependencies: [] }] } } }), '`modules.AppModule.providers[0]` has no `name`'],
      [graph({ modules: { AppModule: { ...appModule, providers: [{ name: 'A' }] } } }), '`modules.AppModule.providers[0].dependencies` is not a list'],
      [
        graph({ modules: { AppModule: { ...appModule, providers: [{ name: 'A', dependencies: [{ token: 'B' }] }] } } }),
        '`modules.AppModule.providers[0].dependencies[0]` is not a dependency'
      ],
      [
        graph({ modules: { AppModule: { ...appModule, providers: [{ name: 'A', dependencies: [], directRun: { methods: {} } }] } } }),
        '`modules.AppModule.providers[0].directRun.methods` is not a list'
      ],
      [
        graph({ modules: { AppModule: { ...appModule, providers: [{ name: 'A', dependencies: [], directRun: { methods: [{ name: 'run' }] } }] } } }),
        '`modules.AppModule.providers[0].directRun.methods[0]` is not a method'
      ],
      [
        graph({ modules: { AppModule: { ...appModule, controllers: [{ name: 'C', dependencies: [], jsdoc: 1 }] } } }),
        '`modules.AppModule.controllers[0].jsdoc` is not text'
      ],
      [graph({ modules: { AppModule: { ...appModule, jsdoc: false } } }), '`modules.AppModule.jsdoc` is not text'],
      [graph({ cycles: [] }), '`cycles` is not an object'],
      [graph({ cycles: { modules: [], providers: [] } }), '`cycles.controllers` is not a list'],
      [graph({ cycles: { modules: [{ from: 'A', to: 'B' }], providers: [], controllers: [] } }), '`cycles.modules[0]` is not a cycle'],
      // The viewer reads every step of a cycle's path, so each must be one.
      [graph({ cycles: { modules: [{ from: 'A', to: 'B', path: [1, 2] }], providers: [], controllers: [] } }), '`cycles.modules[0]` is not a cycle'],
      [graph({ cycles: { modules: [], providers: [], controllers: [{ from: 'A', to: 'B', path: [{}] }] } }), '`cycles.controllers[0]` is not a cycle'],
      [graph({ cycles: { modules: [], providers: [{ from: 'A', to: 'B', path: [null] }], controllers: [] } }), '`cycles.providers[0]` is not a cycle'],
      [
        graph({ cycles: { modules: [], providers: [{ from: 'A', to: 'B', path: [{ module: { name: 'AppModule' }, provider: {} }] }], controllers: [] } }),
        '`cycles.providers[0]` is not a cycle'
      ],
      [
        graph({ cycles: { modules: [], providers: [{ from: 'A', to: 'B', path: ['AppModule:AppService'] }], controllers: [] } }),
        '`cycles.providers[0]` is not a cycle'
      ],
      // A module name that is not an identifier is quoted in the path.
      [
        graph({ root: 'App Module', modules: { 'App Module': { ...appModule, imports: null } } }),
        '`modules["App Module"].imports` is not a list of names'
      ]
    ]

    for (const [value, detail] of cases) {
      const result = failure(readGraphOutput(value, FILE))

      assert.equal(result.problem, 'not-a-graph', detail)
      assert.equal(
        result.message,
        `graph.json is not a Nest Graph Inspector graph: ${detail}. Export it again with npx nest-graph-inspector export.`
      )
    }
  })

  test('sizes are said in megabytes', () => {
    assert.equal(formatFileSize(0), '0 MB')
    assert.equal(formatFileSize(1.25 * 1024 * 1024), '1.3 MB')
    assert.equal(formatFileSize(MAX_GRAPH_FILE_BYTES), '20 MB')
  })
})
