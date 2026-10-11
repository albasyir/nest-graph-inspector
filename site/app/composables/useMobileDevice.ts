import { MOBILE_VIEWPORT_QUERY, isMobileDevice } from '~/utils/device-detection'

/**
 * Whether this tab is on a mobile device, kept current as the window changes.
 *
 * `isMobile` is `false` on the server, which cannot see the device, and stays so
 * until the client has asked — `isChecking` says the answer is not in yet. A
 * component being hydrated asks once it is mounted, so its first client render
 * agrees with the server's; anything rendered on the client alone asks straight
 * away, so the very first render already knows.
 *
 * After that it follows the window: a phone rotated past the breakpoint, or a
 * desktop window dragged narrower, changes the answer without a reload.
 */
export function useMobileDevice() {
  const isMobile = ref(false)
  const isChecking = ref(import.meta.client)

  function checkIsMobile(): boolean {
    isMobile.value = isMobileDevice()
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
