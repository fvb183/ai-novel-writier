import { useEffect, useSyncExternalStore } from 'react'

const MOBILE_QUERY = '(max-width: 899px)'
const subscribe = (notify: () => void) => {
  const query = window.matchMedia(MOBILE_QUERY)
  query.addEventListener('change', notify)
  return () => query.removeEventListener('change', notify)
}
const getSnapshot = () => window.matchMedia(MOBILE_QUERY).matches

export function useCompactLayout() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/** One layout tree: changing orientation or opening the IME never remounts drafts. */
export function useMobileLayout() {
  const compact = useCompactLayout()
  useEffect(() => {
    document.documentElement.dataset.mobileLayout = String(compact)
    const viewport = window.visualViewport
    const updateViewport = () => {
      const height = viewport?.height ?? window.innerHeight
      document.documentElement.style.setProperty('--app-viewport-height', `${height}px`)
      document.documentElement.dataset.keyboardOpen = String(window.innerHeight - height > 150)
    }
    updateViewport()
    viewport?.addEventListener('resize', updateViewport)
    viewport?.addEventListener('scroll', updateViewport)
    window.addEventListener('resize', updateViewport)
    return () => {
      viewport?.removeEventListener('resize', updateViewport)
      viewport?.removeEventListener('scroll', updateViewport)
      window.removeEventListener('resize', updateViewport)
    }
  }, [compact])
  return compact
}
