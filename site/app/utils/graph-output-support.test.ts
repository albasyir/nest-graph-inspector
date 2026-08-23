import { strict as assert } from 'node:assert'
import {
  MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION,
  isLegacyGraphOutput,
  isSupportedGraphOutputVersion
} from './graph-output-support.ts'

// The version arrives as whatever the JSON held, so a string and a number are
// both normal — this is what decides between the graph and an upgrade prompt.
assert.equal(MINIMUM_SUPPORTED_GRAPH_OUTPUT_VERSION, 3)

for (const supported of [3, '3', 4, '4', 10, '10', '3.9']) {
  assert.ok(
    isSupportedGraphOutputVersion(supported),
    `version ${JSON.stringify(supported)} should render`
  )
}

for (const unsupported of [0, 1, 2, '0', '1', '2', -1]) {
  assert.equal(
    isSupportedGraphOutputVersion(unsupported),
    false,
    `version ${JSON.stringify(unsupported)} should prompt an upgrade`
  )
}

// Nonsense is not a version, and must not be treated as a new one.
for (const nonsense of [undefined, null, '', 'latest', {}, [], true, NaN]) {
  assert.equal(
    isSupportedGraphOutputVersion(nonsense),
    false,
    `${JSON.stringify(nonsense)} should not count as a supported version`
  )
}

// An older library answered the endpoint path with the graph itself. Spotting
// that is how the viewer tells "upgrade the library" from "wrong address".
assert.ok(isLegacyGraphOutput({ version: '1', root: 'AppModule', modules: [] }))
assert.ok(isLegacyGraphOutput({ version: 2, root: {}, modules: {} }))

// The endpoint's own payload is not a graph, and must not be mistaken for one.
assert.equal(
  isLegacyGraphOutput({ 'for': 'nest-graph-inspector', 'is-static': false }),
  false
)

// Any missing key means it is not the shape being recognised.
assert.equal(isLegacyGraphOutput({ version: '1', root: 'AppModule' }), false)
assert.equal(isLegacyGraphOutput({ root: 'AppModule', modules: [] }), false)
assert.equal(isLegacyGraphOutput({ version: '1', modules: [] }), false)

for (const notAnObject of [undefined, null, '', 'graph', 0, false]) {
  assert.equal(
    isLegacyGraphOutput(notAnObject),
    false,
    `${JSON.stringify(notAnObject)} should not look like a graph`
  )
}

console.log('graph-output-support.test.ts ok')
