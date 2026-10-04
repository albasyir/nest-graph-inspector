/**
 * Whether this tab is on a phone or tablet, where the in-browser AI chat stays off.
 *
 * WebLLM decodes on the GPU through WebGPU, and even the recommended model needs
 * about 2 GB of it. A mobile browser that exposes WebGPU at all hands a page far
 * less memory than that before it kills the tab, so offering the download there
 * trades a disabled button for a crash halfway through a multi-gigabyte fetch.
 *
 * Every check reads injected values first and the browser globals second, so the
 * whole module runs under the site's plain `node --test` runner, and asking on a
 * server — where there is no window to measure — answers "not mobile" rather
 * than throwing.
 */

/** The viewport width, in CSS pixels, below which a tab counts as mobile. Tailwind's `md`. */
export const MOBILE_BREAKPOINT_PX = 768

/** The same breakpoint as a media query, for `matchMedia` and its `change` events. */
export const MOBILE_VIEWPORT_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX - 0.02}px)`

export const MOBILE_DISCLAIMER_MESSAGE = 'WebLLM requires desktop WebGPU resources and is disabled on mobile devices.'

export const MOBILE_DRAWER_BANNER_TITLE = 'Desktop Browser Required'

export const MOBILE_DRAWER_BANNER_MESSAGE = 'In-browser AI inference is only supported on desktop browsers. WebLLM requires desktop WebGPU resources and is disabled on mobile devices to prevent memory exhaustion and browser tab crashes.'

/**
 * Phone and tablet browsers name themselves in the user agent. `Mobile` covers
 * Mobile Safari, Chrome on Android phones and Firefox for Android; the rest are
 * platforms whose browsers leave that word out.
 */
const MOBILE_USER_AGENT_PATTERN = /Android|iPhone|iPad|iPod|BlackBerry|BB10|IEMobile|Windows Phone|Opera Mini|Opera Mobi|webOS|Silk|Kindle|Mobile/i

const COARSE_POINTER_QUERY = '(pointer: coarse)'

/** The parts of `Navigator` these checks read, so a test can hand in a plain object. */
export type DeviceNavigator = {
  userAgent?: string
  maxTouchPoints?: number
}

/** The parts of `Window` these checks read, so a test can hand in a plain object. */
export type DeviceWindow = {
  innerWidth?: number
  matchMedia?: (query: string) => { matches: boolean }
  ontouchstart?: unknown
}

export type DeviceDetectionOptions = {
  /** Overrides the navigator's user agent. */
  userAgent?: string
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

export function isMobileUserAgent(ua: string = browserNavigator()?.userAgent ?? ''): boolean {
  return MOBILE_USER_AGENT_PATTERN.test(ua)
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

/** An iPad on iPadOS 13 or later, which reports a Mac user agent. */
function isIpadOs(ua: string, nav: DeviceNavigator | undefined, win: DeviceWindow | undefined): boolean {
  return /Macintosh/i.test(ua) && isTouchDevice(nav, win)
}

/**
 * Whether the in-browser AI chat should stay off here.
 *
 * A mobile user agent, an iPad posing as a Mac, or a viewport narrower than
 * {@link MOBILE_BREAKPOINT_PX} — measured by `innerWidth`, or by the media query
 * when no width is known. With no window and nothing injected, which is a
 * server render, the answer is `false`: the server cannot see the device, and
 * the client asks again once it is mounted.
 */
export function isMobileDevice(options: DeviceDetectionOptions = {}): boolean {
  const win = options.window ?? browserWindow()
  const nav = options.navigator ?? browserNavigator()
  const ua = options.userAgent ?? nav?.userAgent ?? ''

  if (isMobileUserAgent(ua) || isIpadOs(ua, nav, win)) {
    return true
  }

  const width = options.viewportWidth ?? win?.innerWidth

  if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
    return isMobileViewport(width)
  }

  return matchesMedia(win, MOBILE_VIEWPORT_QUERY)
}
