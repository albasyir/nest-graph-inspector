import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { splitNameIntoWords } from './module-name-words.ts'

describe('module name words', () => {
  test('a name breaks between the words it is written in', () => {
    assert.deepEqual(splitNameIntoWords('CustomerLoyaltyModule'), ['Customer', 'Loyalty', 'Module'])
    assert.deepEqual(splitNameIntoWords('NestJSCoreModule'), ['Nest', 'JS', 'Core', 'Module'])
    assert.deepEqual(splitNameIntoWords('HTTPModule'), ['HTTP', 'Module'])
    assert.deepEqual(splitNameIntoWords('Auth2Module'), ['Auth2', 'Module'])
    assert.deepEqual(splitNameIntoWords('legacy_module'), ['legacy', '_', 'module'])
    assert.deepEqual(splitNameIntoWords(''), [''])
  })

  test('every name in the demo graph joins back from its words', () => {
    const graph: unknown = JSON.parse(readFileSync(new URL('../../public/nodepod-demo/graph.json', import.meta.url), 'utf8'))
    const modules = typeof graph === 'object' && graph !== null && 'modules' in graph ? graph.modules : null
    assert.ok(modules && typeof modules === 'object')
    const names = Object.keys(modules)
    assert.ok(names.length > 0)
    for (const name of [...names, 'A$Weird.Name', '42']) {
      assert.equal(splitNameIntoWords(name).join(''), name, name)
    }
  })
})
