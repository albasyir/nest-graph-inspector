/**
 * Whether the in-browser AI chat stays off in this tab: on a phone or tablet, and
 * in any window narrower than {@link MOBILE_BREAKPOINT_PX}, desktop included.
 *
 * WebLLM decodes on the GPU through WebGPU, and even the recommended model needs
 * about 2 GB of it. A mobile browser that exposes WebGPU at all hands a page far
 * less memory than that before it kills the tab, so offering the download there
 * trades a disabled button for a crash halfway through a multi-gigabyte fetch.
 *
 * What kind of device this is comes from `@nuxtjs/device`: its `useDevice()`
 * flags classify the user agent, and this module reads them rather than keeping
 * a pattern of its own. Two things no user agent says are added on top — an iPad
 * on iPadOS 13 or later, which sends a Mac's user agent, and the window's width.
 *
 * The flags are handed in, and every other check reads injected values first and
 * the browser globals second, so the whole module runs under the site's plain
 * `node --test` runner, and asking on a server — where there is no window to
 * measure — answers from the flags alone rather than throwing.
 */

/** The viewport width, in CSS pixels, below which the chat stays off on any device. Tailwind's `md`. */
export const MOBILE_BREAKPOINT_PX = 768

/** The same breakpoint as a media query, for `matchMedia` and its `change` events. */
export const MOBILE_VIEWPORT_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 0.02}px)`

export const MOBILE_DISCLAIMER_MESSAGE = `WebLLM is disabled on mobile devices and in browser windows narrower than ${MOBILE_BREAKPOINT_PX}px.`

export const MOBILE_DRAWER_BANNER_TITLE = 'Unavailable on Mobile or in Narrow Browser Windows'

export const MOBILE_DRAWER_BANNER_MESSAGE = `In-browser AI inference is only supported in desktop browser windows at least ${MOBILE_BREAKPOINT_PX}px wide. WebLLM is disabled on mobile devices to prevent memory exhaustion and browser tab crashes; on a desktop, widen this window to use it.`

const COARSE_POINTER_QUERY = '(pointer: coarse)'

/**
 * The `useDevice()` flags these checks read — a slice of `@nuxtjs/device`'s
 * `Device`, so a test can hand in a plain object.
 */
export type DeviceFlags = {
  /** A phone or a tablet, by its user agent. */
  isMobileOrTablet: boolean
  /** A user agent that names Mac OS X — which, since iPadOS 13, an iPad's does too. */
  isMacOS: boolean
}

/** The parts of `Navigator` these checks read, so a test can hand in a plain object. */
export type DeviceNavigator = {
  maxTouchPoints?: number
}

/** The parts of `Window` these checks read, so a test can hand in a plain object. */
export type DeviceWindow = {
  innerWidth?: number
  matchMedia?: (query: string) => { matches: boolean }
  ontouchstart?: unknown
}

export type DeviceDetectionOptions = {
  /** Overrides the window's `innerWidth`. */
  viewportWidth?: number
  navigator?: DeviceNavigator
  window?: DeviceWindow
}

function browserWindow(): DeviceWindow | undefined {
  return typeof window === 'undefined' ? undefined : window
}

/**
 * Node has a `navigator` of its own since version 21, so its presence alone does
 * not mean a browser; only a window does.
 */
function browserNavigator(): DeviceNavigator | undefined {
  return typeof window === 'undefined' || typeof navigator === 'undefined' ? undefined : navigator
}

/** A media query the browser refuses to parse is a "no", not a crash. */
function matchesMedia(win: DeviceWindow | undefined, query: string): boolean {
  try {
    return Boolean(win?.matchMedia?.(query).matches)
  } catch {
    return false
  }
}

/**
 * Whether the device takes touch input.
 *
 * Not a mobile check on its own: touchscreen laptops answer yes and run the
 * chat perfectly well. It decides one case only — an iPad, which since iPadOS 13
 * sends the same user agent as a Mac, and is told apart by having a touchscreen
 * no Mac has.
 */
export function isTouchDevice(
  nav: DeviceNavigator | undefined = browserNavigator(),
  win: DeviceWindow | undefined = browserWindow()
): boolean {
  if ((nav?.maxTouchPoints ?? 0) > 0) {
    return true
  }

  if (win && 'ontouchstart' in win) {
    return true
  }

  return matchesMedia(win, COARSE_POINTER_QUERY)
}

export function isMobileViewport(width: number | undefined = browserWindow()?.innerWidth): boolean {
  return typeof width === 'number'
    && Number.isFinite(width)
    && width > 0
    && width < MOBILE_BREAKPOINT_PX
}

/**
 * An iPad on iPadOS 13 or later, which reports a Mac user agent — so
 * `@nuxtjs/device` counts it as a desktop, and only its touchscreen gives it away.
 */
function isIpadOs(device: DeviceFlags, nav: DeviceNavigator | undefined, win: DeviceWindow | undefined): boolean {
  return device.isMacOS && isTouchDevice(nav, win)
}

/**
 * Whether the in-browser AI chat should stay off here.
 *
 * A phone or a tablet as `useDevice()` classifies it, an iPad posing as a Mac,
 * or a viewport narrower than {@link MOBILE_BREAKPOINT_PX} — measured by
 * `innerWidth`, or by the media query when no width is known. With no window
 * and nothing injected, which is a server render, only the flags can answer:
 * the server sees at most a user agent, and the client asks again once it is
 * mounted.
 */
export function isMobileDevice(device: DeviceFlags, options: DeviceDetectionOptions = {}): boolean {
  const win = options.window ?? browserWindow()
  const nav = options.navigator ?? browserNavigator()

  if (device.isMobileOrTablet || isIpadOs(device, nav, win)) {
    return true
  }

  const width = options.viewportWidth ?? win?.innerWidth

  if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
    return isMobileViewport(width)
  }

  return matchesMedia(win, MOBILE_VIEWPORT_QUERY)
}
