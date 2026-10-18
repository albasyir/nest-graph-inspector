import { MOBILE_VIEWPORT_QUERY, isMobileDevice } from '~/utils/device-detection'

/**
 * Whether this tab is on a mobile device, kept current as the window changes.
 *
 * The device itself is what `@nuxtjs/device` says it is: `useDevice()` classifies
 * the user agent, and `isMobileDevice` adds what a user agent cannot say — an
 * iPad posing as a Mac, and a window narrower than the chat's breakpoint. So
 * `isMobile` here is wider than `useDevice().isMobile`, which means a phone and
 * nothing else.
 *
 * `isMobile` is `false` on the server, which sees at most a user agent — the
 * module's default one, in a prerender — and never the window, and it stays so
 * until the client has asked — `isChecking` says the answer is not in yet. A
 * component being hydrated asks once it is mounted, so its first client render
 * agrees with the server's; anything rendered on the client alone asks straight
 * away, so the very first render already knows.
 *
 * After that it follows the window: a phone rotated past the breakpoint, or a
 * desktop window dragged narrower, changes the answer without a reload.
 */
export function useMobileDevice() {
  // Read here, in setup, because `useDevice` needs the Nuxt app. The flags are
  // fixed for the life of the page, so the listeners below can read them later.
  const device = useDevice()
  const isMobile = ref(false)
  const isChecking = ref(import.meta.client)

  function checkIsMobile(): boolean {
    isMobile.value = isMobileDevice(device)
    isChecking.value = false

    return isMobile.value
  }

  if (import.meta.client) {
    let mediaQuery: MediaQueryList | undefined
    let isDisposed = false

    const start = () => {
      if (isDisposed) {
        return
      }

      checkIsMobile()
      window.addEventListener('resize', checkIsMobile, { passive: true })
      mediaQuery = window.matchMedia?.(MOBILE_VIEWPORT_QUERY)
      mediaQuery?.addEventListener('change', checkIsMobile)
    }

    if (getCurrentInstance() && tryUseNuxtApp()?.isHydrating) {
      onMounted(start)
    } else {
      start()
    }

    if (getCurrentScope()) {
      onScopeDispose(() => {
        isDisposed = true
        window.removeEventListener('resize', checkIsMobile)
        mediaQuery?.removeEventListener('change', checkIsMobile)
        mediaQuery = undefined
      })
    }
  }

  return {
    isMobile: readonly(isMobile),
    isChecking: readonly(isChecking),
    checkIsMobile
  }
}
