import { strict as assert } from 'node:assert'
import { registerHooks } from 'node:module'
import { describe, test } from 'node:test'
import { MOBILE_DISCLAIMER_MESSAGE, type DeviceFlags } from './device-detection.ts'

/**
 * `useWebLlmEngine` is a Nuxt composable: it reaches its siblings through the
 * `~` alias and calls `ref` and `useDevice` as auto-imports. None of them exists
 * under the plain runner, so they are supplied here — the alias by a resolve
 * hook, `ref` by a stand-in that only has to hold a value, and `useDevice` by
 * one that hands back whatever flags the test has set, as `@nuxtjs/device`
 * would from the Nuxt app — instead of rewriting the composable into something
 * Nuxt would not write.
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

const DESKTOP_FLAGS: DeviceFlags = { isMobileOrTablet: false, isMacOS: false }
const PHONE_FLAGS: DeviceFlags = { isMobileOrTablet: true, isMacOS: true }

let deviceFlags = DESKTOP_FLAGS

Object.assign(globalThis, {
  ref: <T>(value: T) => ({ value }),
  useDevice: () => deviceFlags
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

    // What an earlier failure left behind. The panel words this refusal from
    // `error`, then `supportReason`, so both have to name it, not what was there.
    engine.error.value = 'Qwen3-1.7B-q4f16_1-MLC could not be removed from this browser. The browser gave no reason.'

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
    assert.equal(engine.error.value, MOBILE_DISCLAIMER_MESSAGE, 'not the stale failure, which the panel would repeat')
    assert.equal(engine.supportReason.value, MOBILE_DISCLAIMER_MESSAGE, 'not empty, which the panel would replace with a WebGPU hint')
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

  test('without an injected answer it asks useDevice(), and a desktop is not refused', async () => {
    deviceFlags = DESKTOP_FLAGS
    const engine = useWebLlmEngine()

    assert.equal(await engine.checkSupport(), false)
    assert.equal(engine.supportReason.value, '', 'a desktop with no window to measure is not refused')
  })

  test('without an injected answer a phone, as useDevice() classifies it, is refused', async () => {
    deviceFlags = PHONE_FLAGS

    try {
      const engine = useWebLlmEngine()

      assert.equal(await engine.checkSupport(), false)
      assert.equal(engine.supportReason.value, MOBILE_DISCLAIMER_MESSAGE)
    } finally {
      deviceFlags = DESKTOP_FLAGS
    }
  })

  test('never loads the browser-only web-llm runtime', () => {
    assert.equal(hasRequestedWebLlm(), false)
  })
})
