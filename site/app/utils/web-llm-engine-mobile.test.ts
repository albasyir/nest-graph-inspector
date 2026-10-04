import { strict as assert } from 'node:assert'
import { registerHooks } from 'node:module'
import { describe, test } from 'node:test'
import { MOBILE_DISCLAIMER_MESSAGE } from './device-detection.ts'

/**
 * `useWebLlmEngine` is a Nuxt composable: it reaches its siblings through the
 * `~` alias and calls `ref` as an auto-import. Neither exists under the plain
 * runner, so both are supplied here — the alias by a resolve hook, `ref` by a
 * stand-in that only has to hold a value — instead of rewriting the composable
 * into something Nuxt would not write.
 *
 * The hook also records every request for `@mlc-ai/web-llm`, which is the
 * whole point of the mobile guard: the browser-only runtime is never loaded.
 */
const requestedSpecifiers: string[] = []

registerHooks({
  resolve(specifier, context, nextResolve) {
    requestedSpecifiers.push(specifier)

    if (specifier.startsWith('~/')) {
      return {
        url: new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href,
        shortCircuit: true
      }
    }

    return nextResolve(specifier, context)
  }
})

Object.assign(globalThis, {
  ref: <T>(value: T) => ({ value })
})

const { WebLlmError, useWebLlmEngine } = await import('../composables/useWebLlmEngine.ts')

function hasRequestedWebLlm() {
  return requestedSpecifiers.some(specifier => specifier.includes('@mlc-ai/web-llm'))
}

describe('useWebLlmEngine on a mobile device', () => {
  test('refuses support without probing WebGPU', async () => {
    const engine = useWebLlmEngine({ isMobile: () => true })

    assert.equal(await engine.checkSupport(), false)
    assert.equal(engine.isSupported.value, false)
    assert.equal(engine.supportReason.value, MOBILE_DISCLAIMER_MESSAGE)
    assert.equal(engine.isCheckingSupport.value, false, 'a refusal is not a probe in progress')
  })

  test('reads no catalog, and says why instead of leaving an empty menu', async () => {
    const engine = useWebLlmEngine({ isMobile: () => true })

    await engine.refreshCatalog()

    assert.deepEqual(engine.catalog.value, [])
    assert.deepEqual(engine.cachedModelIds.value, [])
    assert.equal(engine.hasLoadedCatalog.value, false)
    assert.equal(engine.isLoadingCatalog.value, false)
    assert.equal(engine.error.value, MOBILE_DISCLAIMER_MESSAGE)
  })

  test('forgets a catalog read before the device turned out to be mobile', async () => {
    let isMobile = false
    const engine = useWebLlmEngine({ isMobile: () => isMobile })

    engine.catalog.value = [{ id: 'stale' } as (typeof engine.catalog.value)[number]]
    engine.cachedModelIds.value = ['stale']
    engine.hasLoadedCatalog.value = true
    isMobile = true

    await engine.refreshCatalog()

    assert.deepEqual(engine.catalog.value, [])
    assert.deepEqual(engine.cachedModelIds.value, [])
    assert.equal(engine.hasLoadedCatalog.value, false)
  })

  test('refuses to prepare a model with an unsupported error the panel can word', async () => {
    const engine = useWebLlmEngine({ isMobile: () => true })

    await assert.rejects(
      engine.prepareModel('Qwen3-1.7B-q4f16_1-MLC'),
      (error: unknown) => {
        assert.ok(error instanceof WebLlmError)
        assert.equal(error.kind, 'unsupported')
        assert.equal(error.message, MOBILE_DISCLAIMER_MESSAGE)
        return true
      }
    )
    assert.equal(engine.isPreparingModel.value, false)
    assert.equal(engine.loadedModelId.value, '')
    assert.equal(engine.error.value, MOBILE_DISCLAIMER_MESSAGE)
  })

  test('refuses to stream, and never calls back with a delta', async () => {
    const engine = useWebLlmEngine({ isMobile: () => true })
    const deltas: unknown[] = []

    await assert.rejects(
      engine.streamChat('Qwen3-1.7B-q4f16_1-MLC', [{ role: 'user', content: 'Hi' }], { enableThinking: false }, (delta) => {
        deltas.push(delta)
      }),
      (error: unknown) => {
        assert.ok(error instanceof WebLlmError)
        assert.equal(error.kind, 'unsupported')
        assert.equal(error.message, MOBILE_DISCLAIMER_MESSAGE)
        return true
      }
    )
    assert.deepEqual(deltas, [])
    assert.equal(engine.isGenerating.value, false)
  })

  test('asks the device on every call, so a window that changes is followed', async () => {
    let isMobile = true
    const engine = useWebLlmEngine({ isMobile: () => isMobile })

    assert.equal(await engine.checkSupport(), false)
    assert.equal(engine.supportReason.value, MOBILE_DISCLAIMER_MESSAGE)

    // Off mobile, outside a browser: the existing "not on the client" answer,
    // and still no reason to reach for web-llm.
    isMobile = false
    assert.equal(await engine.checkSupport(), false)
    await engine.prepareModel('Qwen3-1.7B-q4f16_1-MLC')
    assert.equal(engine.error.value, '')
  })

  test('without an injected answer it asks the device, which a server cannot see', async () => {
    const engine = useWebLlmEngine()

    assert.equal(await engine.checkSupport(), false)
    assert.equal(engine.supportReason.value, '', 'no window means not mobile, not refused')
  })

  test('never loads the browser-only web-llm runtime', () => {
    assert.equal(hasRequestedWebLlm(), false)
  })
})
