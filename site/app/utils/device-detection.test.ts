import { strict as assert } from 'node:assert'
import { describe, test } from 'node:test'
import {
  MOBILE_BREAKPOINT_PX,
  MOBILE_DISCLAIMER_MESSAGE,
  MOBILE_DRAWER_BANNER_MESSAGE,
  MOBILE_DRAWER_BANNER_TITLE,
  MOBILE_VIEWPORT_QUERY,
  isMobileDevice,
  isMobileUserAgent,
  isMobileViewport,
  isTouchDevice,
  type DeviceWindow
} from './device-detection.ts'

const DESKTOP_USER_AGENTS = {
  'Chrome on Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Edge on Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  'Safari on macOS': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Firefox on Linux': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Chrome on ChromeOS': 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
}

const MOBILE_USER_AGENTS = {
  'Chrome on an Android phone': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  'Chrome on an Android tablet': 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Firefox for Android': 'Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0',
  'Safari on iPhone': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Safari on an iPad before iPadOS 13': 'Mozilla/5.0 (iPad; CPU OS 12_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1 Mobile/15E148 Safari/604.1',
  'Safari on an iPod touch': 'Mozilla/5.0 (iPod touch; CPU iPhone OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1',
  'BlackBerry': 'Mozilla/5.0 (BlackBerry; U; BlackBerry 9900; en) AppleWebKit/534.11+ (KHTML, like Gecko) Version/7.1.0.346 Mobile Safari/534.11+',
  'IE Mobile': 'Mozilla/5.0 (compatible; MSIE 10.0; Windows Phone 8.0; Trident/6.0; IEMobile/10.0; ARM; Touch; NOKIA; Lumia 920)',
  'Opera Mini': 'Opera/9.80 (J2ME/MIDP; Opera Mini/9.80 (S60; SymbOS; Opera Mobi/23.348; U; en) Presto/2.5.25 Version/10.54',
  'Samsung Internet': 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36'
}

/** An iPad on iPadOS 13 or later asks for the desktop site, Mac user agent and all. */
const IPADOS_USER_AGENT = DESKTOP_USER_AGENTS['Safari on macOS']

type FakeWindowOptions = {
  width?: number
  matchingQueries?: string[]
  touchEvents?: boolean
}

function fakeWindow({ width, matchingQueries = [], touchEvents = false }: FakeWindowOptions = {}): DeviceWindow {
  return {
    ...(width === undefined ? {} : { innerWidth: width }),
    ...(touchEvents ? { ontouchstart: null } : {}),
    matchMedia: (query: string) => ({ matches: matchingQueries.includes(query) })
  }
}

describe('the copy the panel and the header show', () => {
  test('the breakpoint is Tailwind\'s md', () => {
    assert.equal(MOBILE_BREAKPOINT_PX, 768)
  })

  test('the media query matches below the breakpoint and not at it', () => {
    assert.equal(MOBILE_VIEWPORT_QUERY, '(max-width: 767.98px)')
  })

  test('the messages say what the chat needs, and why', () => {
    assert.equal(MOBILE_DISCLAIMER_MESSAGE, 'WebLLM requires desktop WebGPU resources and is disabled on mobile devices.')
    assert.equal(MOBILE_DRAWER_BANNER_TITLE, 'Desktop Browser Required')
    assert.equal(
      MOBILE_DRAWER_BANNER_MESSAGE,
      'In-browser AI inference is only supported on desktop browsers. WebLLM requires desktop WebGPU resources and is disabled on mobile devices to prevent memory exhaustion and browser tab crashes.'
    )
  })
})

describe('isMobileUserAgent', () => {
  for (const [name, ua] of Object.entries(MOBILE_USER_AGENTS)) {
    test(`recognises ${name}`, () => {
      assert.equal(isMobileUserAgent(ua), true)
    })
  }

  for (const [name, ua] of Object.entries(DESKTOP_USER_AGENTS)) {
    test(`leaves ${name} alone`, () => {
      assert.equal(isMobileUserAgent(ua), false)
    })
  }

  test('is case-insensitive', () => {
    assert.equal(isMobileUserAgent('some browser on an IPHONE'), true)
  })

  test('an empty user agent is not mobile', () => {
    assert.equal(isMobileUserAgent(''), false)
  })

  test('with no browser to ask — this runner, or a server — the answer is no', () => {
    assert.equal(isMobileUserAgent(), false)
  })
})

describe('isTouchDevice', () => {
  test('touch points on the navigator are touch', () => {
    assert.equal(isTouchDevice({ maxTouchPoints: 5 }, fakeWindow()), true)
  })

  test('a window that takes touch events is touch', () => {
    assert.equal(isTouchDevice({ maxTouchPoints: 0 }, fakeWindow({ touchEvents: true })), true)
  })

  test('a coarse pointer is touch', () => {
    assert.equal(isTouchDevice({ maxTouchPoints: 0 }, fakeWindow({ matchingQueries: ['(pointer: coarse)'] })), true)
  })

  test('a mouse and a keyboard are not', () => {
    assert.equal(isTouchDevice({ maxTouchPoints: 0 }, fakeWindow()), false)
  })

  test('a navigator that says nothing about touch is not', () => {
    assert.equal(isTouchDevice({}, {}), false)
  })

  test('a media query that throws is a no, not a crash', () => {
    assert.equal(isTouchDevice({}, {
      matchMedia: () => {
        throw new Error('unsupported query')
      }
    }), false)
  })

  test('with no browser at all, nothing is touch', () => {
    assert.equal(isTouchDevice(), false)
    assert.equal(isTouchDevice(undefined, undefined), false)
  })
})

describe('isMobileViewport', () => {
  for (const width of [320, 375, 414, 600, 767, 767.98]) {
    test(`${width}px is mobile`, () => {
      assert.equal(isMobileViewport(width), true)
    })
  }

  for (const width of [768, 820, 1024, 1280, 1920, 3840]) {
    test(`${width}px is not`, () => {
      assert.equal(isMobileViewport(width), false)
    })
  }

  test('a width that is not a measurement is not mobile', () => {
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(isMobileViewport(width), false, String(width))
    }
  })

  test('with no window to measure, the answer is no', () => {
    assert.equal(isMobileViewport(), false)
    assert.equal(isMobileViewport(undefined), false)
  })
})

describe('isMobileDevice', () => {
  test('server rendering — no window, nothing injected — is not mobile', () => {
    assert.equal(typeof window, 'undefined')
    assert.equal(isMobileDevice(), false)
    assert.equal(isMobileDevice({}), false)
  })

  for (const [name, ua] of Object.entries(DESKTOP_USER_AGENTS)) {
    test(`${name} in a wide window is a desktop`, () => {
      assert.equal(isMobileDevice({
        navigator: { userAgent: ua, maxTouchPoints: 0 },
        window: fakeWindow({ width: 1440 })
      }), false)
    })
  }

  for (const [name, ua] of Object.entries(MOBILE_USER_AGENTS)) {
    test(`${name} is mobile whatever the width`, () => {
      assert.equal(isMobileDevice({
        navigator: { userAgent: ua, maxTouchPoints: 5 },
        window: fakeWindow({ width: 1280 })
      }), true)
    })
  }

  test('an iPad posing as a Mac is told apart by its touchscreen', () => {
    assert.equal(isMobileDevice({
      navigator: { userAgent: IPADOS_USER_AGENT, maxTouchPoints: 5 },
      window: fakeWindow({ width: 1024 })
    }), true)
  })

  test('an iPad posing as a Mac is caught by touch events as well', () => {
    assert.equal(isMobileDevice({
      navigator: { userAgent: IPADOS_USER_AGENT, maxTouchPoints: 0 },
      window: fakeWindow({ width: 1366, touchEvents: true })
    }), true)
  })

  test('a real Mac has no touchscreen, so stays a desktop', () => {
    assert.equal(isMobileDevice({
      navigator: { userAgent: IPADOS_USER_AGENT, maxTouchPoints: 0 },
      window: fakeWindow({ width: 1512 })
    }), false)
  })

  test('a touchscreen laptop is a desktop: touch alone is not mobile', () => {
    assert.equal(isMobileDevice({
      navigator: { userAgent: DESKTOP_USER_AGENTS['Chrome on Windows'], maxTouchPoints: 10 },
      window: fakeWindow({ width: 1440, touchEvents: true, matchingQueries: ['(pointer: coarse)'] })
    }), false)
  })

  test('a desktop window narrower than the breakpoint is a mobile viewport', () => {
    assert.equal(isMobileDevice({
      navigator: { userAgent: DESKTOP_USER_AGENTS['Firefox on Linux'], maxTouchPoints: 0 },
      window: fakeWindow({ width: 600 })
    }), true)
  })

  test('the breakpoint itself is a desktop width', () => {
    const navigator = { userAgent: DESKTOP_USER_AGENTS['Chrome on Windows'], maxTouchPoints: 0 }

    assert.equal(isMobileDevice({ navigator, window: fakeWindow({ width: MOBILE_BREAKPOINT_PX - 1 }) }), true)
    assert.equal(isMobileDevice({ navigator, window: fakeWindow({ width: MOBILE_BREAKPOINT_PX }) }), false)
  })

  test('with no width to read, the media query decides', () => {
    const navigator = { userAgent: DESKTOP_USER_AGENTS['Chrome on Windows'], maxTouchPoints: 0 }

    assert.equal(isMobileDevice({ navigator, window: fakeWindow({ matchingQueries: [MOBILE_VIEWPORT_QUERY] }) }), true)
    assert.equal(isMobileDevice({ navigator, window: fakeWindow() }), false)
  })

  test('a measured width outranks the media query', () => {
    assert.equal(isMobileDevice({
      navigator: { userAgent: DESKTOP_USER_AGENTS['Chrome on Windows'], maxTouchPoints: 0 },
      window: fakeWindow({ width: 1280, matchingQueries: [MOBILE_VIEWPORT_QUERY] })
    }), false)
  })

  test('a media query that throws is a no, not a crash', () => {
    assert.equal(isMobileDevice({
      userAgent: DESKTOP_USER_AGENTS['Chrome on Windows'],
      window: {
        matchMedia: () => {
          throw new Error('unsupported query')
        }
      }
    }), false)
  })

  test('an injected user agent and width outrank the navigator and the window', () => {
    const desktop = {
      navigator: { userAgent: DESKTOP_USER_AGENTS['Chrome on Windows'], maxTouchPoints: 0 },
      window: fakeWindow({ width: 1440 })
    }

    assert.equal(isMobileDevice({ ...desktop, userAgent: MOBILE_USER_AGENTS['Safari on iPhone'] }), true)
    assert.equal(isMobileDevice({ ...desktop, viewportWidth: 390 }), true)
    assert.equal(isMobileDevice({
      navigator: { userAgent: DESKTOP_USER_AGENTS['Chrome on Windows'] },
      window: fakeWindow({ width: 390 }),
      viewportWidth: 1440
    }), false)
  })

  test('a user agent and a width are enough on their own, with no window at all', () => {
    assert.equal(isMobileDevice({ userAgent: MOBILE_USER_AGENTS['Chrome on an Android phone'] }), true)
    assert.equal(isMobileDevice({ userAgent: DESKTOP_USER_AGENTS['Chrome on Windows'], viewportWidth: 500 }), true)
    assert.equal(isMobileDevice({ userAgent: DESKTOP_USER_AGENTS['Chrome on Windows'], viewportWidth: 1920 }), false)
  })

  for (const [label, dimensions] of Object.entries({
    'iPhone SE': { width: 375, mobile: true },
    'iPhone 15 Pro Max': { width: 430, mobile: true },
    'Pixel 8 in landscape': { width: 767, mobile: true },
    'iPad mini in portrait': { width: 768, mobile: false },
    'Small laptop': { width: 1280, mobile: false },
    '4K monitor': { width: 3840, mobile: false }
  })) {
    test(`a desktop user agent at ${label} width (${dimensions.width}px) is ${dimensions.mobile ? 'mobile' : 'a desktop'}`, () => {
      assert.equal(isMobileDevice({
        navigator: { userAgent: DESKTOP_USER_AGENTS['Chrome on Windows'], maxTouchPoints: 0 },
        window: fakeWindow({ width: dimensions.width })
      }), dimensions.mobile)
    })
  }
})
