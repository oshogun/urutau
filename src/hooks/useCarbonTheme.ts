import { usePrefersDarkScheme } from '@carbon/react'
import { useEffect } from 'react'
import { useSettings } from '../state/settings'

export type CarbonTheme = 'white' | 'g100'

const THEME_CLASSES = ['cds--white', 'cds--g10', 'cds--g90', 'cds--g100']

export function useCarbonTheme(): CarbonTheme {
  const preference = useSettings((state) => state.theme)
  const prefersDark = usePrefersDarkScheme()
  const dark = preference === 'dark' || (preference === 'system' && prefersDark)
  return dark ? 'g100' : 'white'
}

/**
 * Puts the Carbon theme class on <html> so that everything, including menus
 * and modals that Carbon renders outside the React root, gets the theme tokens.
 * index.html applies the saved theme before first paint; this keeps it in sync.
 */
export function useDocumentTheme(theme: CarbonTheme): void {
  useEffect(() => {
    const root = document.documentElement
    root.classList.remove(...THEME_CLASSES)
    root.classList.add(`cds--${theme}`)
  }, [theme])
}
