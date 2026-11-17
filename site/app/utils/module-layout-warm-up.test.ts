import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { drawsModuleGraphOnArrival } from './module-layout-warm-up.ts'

describe('drawsModuleGraphOnArrival', () => {
  test('the navigator draws the module graph', () => {
    assert.equal(drawsModuleGraphOnArrival({ path: '/view/navigator', preview: null }), true)
    assert.equal(drawsModuleGraphOnArrival({ path: '/view/navigator/', preview: undefined }), true)
  })

  test('/view draws it only for ?preview=true, which opens the example in the navigator', () => {
    assert.equal(drawsModuleGraphOnArrival({ path: '/view', preview: 'true' }), true)
    assert.equal(drawsModuleGraphOnArrival({ path: '/view/', preview: 'true' }), true)
    assert.equal(drawsModuleGraphOnArrival({ path: '/view', preview: null }), false)
    assert.equal(drawsModuleGraphOnArrival({ path: '/view', preview: 'false' }), false)
    assert.equal(drawsModuleGraphOnArrival({ path: '/view', preview: ['true'] }), false)
  })

  test('no other page draws it on arrival, whatever its query', () => {
    for (const path of [
      '/',
      '/getting-started/introduction',
      '/view/issues',
      '/view/trace',
      '/view/navigator/modules/T3JkZXJNb2R1bGU'
    ]) {
      assert.equal(drawsModuleGraphOnArrival({ path, preview: 'true' }), false, path)
    }
  })
})
