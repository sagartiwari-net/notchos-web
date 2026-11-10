import { useSyncExternalStore } from "react"

const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function isMobileNow() {
  return window.matchMedia(MOBILE_QUERY).matches
}

/**
 * True below the mobile breakpoint. Used by the sidebar to become a slide-over sheet.
 * Same result as the stock shadcn hook, but it reads the media query as an external store,
 * so the first render is already right and no state is set from an effect.
 */
export function useIsMobile() {
  return useSyncExternalStore(subscribe, isMobileNow)
}
