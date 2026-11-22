import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { splitNameIntoWords } from './module-name-words.ts'

/**
 * The demo's modules, by name, written out here: the graph the site exports
 * from the demo (`public/nodepod-demo/graph.json`) is a build output, absent
 * from a clean checkout, so no unit test reads it.
 */
const DEMO_MODULE_NAMES = [
  'AppModule',
  'DatabaseModule',
  'AuthModule',
  'CustomerModule',
  'CustomerLoyaltyModule',
  'OrderModule',
  'StoreProductModule',
  'ProductModule',
  'RecommendationModule',
  'StoreModule',
  'VoucherModule',
  'PaymentModule',
  'NestJSCoreModule'
] as const

describe('module name words', () => {
  test('a name breaks between the words it is written in', () => {
    assert.deepEqual(splitNameIntoWords('CustomerLoyaltyModule'), ['Customer', 'Loyalty', 'Module'])
    assert.deepEqual(splitNameIntoWords('NestJSCoreModule'), ['Nest', 'JS', 'Core', 'Module'])
    assert.deepEqual(splitNameIntoWords('HTTPModule'), ['HTTP', 'Module'])
    assert.deepEqual(splitNameIntoWords('Auth2Module'), ['Auth2', 'Module'])
    // An acronym keeps the digits after it, so no card breaks a name between
    // them.
    assert.deepEqual(splitNameIntoWords('HTTP2Module'), ['HTTP2', 'Module'])
    assert.deepEqual(splitNameIntoWords('V2Module'), ['V2', 'Module'])
    assert.deepEqual(splitNameIntoWords('OAuth2Module'), ['O', 'Auth2', 'Module'])
    assert.deepEqual(splitNameIntoWords('legacy_module'), ['legacy', '_', 'module'])
    assert.deepEqual(splitNameIntoWords(''), [''])
  })

  test('every name of the demo, and odder ones, joins back from its words', () => {
    for (const name of [...DEMO_MODULE_NAMES, 'A$Weird.Name', '42', '__proto__', 'a:b', 'OAuth2Module']) {
      assert.equal(splitNameIntoWords(name).join(''), name, name)
    }
  })
})
