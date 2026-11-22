import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import { drawsModuleGraphOnArrival } from './module-layout-warm-up.ts'
import { resolvePreviewModulePage } from './module-page-route.ts'

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

  test('a preview handing a module over opens that module\'s page, which needs no ELK', () => {
    assert.equal(drawsModuleGraphOnArrival({ path: '/view', preview: 'true', module: 'OrderModule' }), false)
    assert.equal(drawsModuleGraphOnArrival({ path: '/view', preview: 'true', module: ['OrderModule'] }), false)
    assert.equal(drawsModuleGraphOnArrival({ path: '/view', preview: 'true', module: '' }), true)
    assert.equal(drawsModuleGraphOnArrival({ path: '/view', preview: 'true', module: null }), true)
  })

  test('/view and the warm-up agree on every address whether a module is handed over', () => {
    // `/view` reads the first of several values, so `?module=&module=X` hands
    // nothing over and opens the navigator: the warm-up must start ELK for it.
    for (const module of ['OrderModule', ['OrderModule'], ['', 'OrderModule'], ['OrderModule', ''], '', [], null, undefined]) {
      const handsOver = resolvePreviewModulePage({ preview: 'true', module }) !== undefined
      assert.equal(
        drawsModuleGraphOnArrival({ path: '/view', preview: 'true', module }),
        !handsOver,
        JSON.stringify(module)
      )
    }
    assert.equal(drawsModuleGraphOnArrival({ path: '/view', preview: 'true', module: ['', 'OrderModule'] }), true)
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
