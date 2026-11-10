import { useEffect } from 'react'

const APP_NAME = 'NotchOS Admin'

/** Sets the browser tab title to "<title> · NotchOS Admin" while the page is shown. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · ${APP_NAME}`
    return () => {
      document.title = APP_NAME
    }
  }, [title])
}
