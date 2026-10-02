import { Asleep, Light, Settings } from '@carbon/icons-react'
import {
  Header,
  HeaderGlobalAction,
  HeaderGlobalBar,
  HeaderName,
  SkipToContent,
  Theme,
} from '@carbon/react'
import type { CarbonTheme } from '../hooks/useCarbonTheme'
import { useSettings } from '../state/settings'

interface AppHeaderProps {
  theme: CarbonTheme
  onHome: () => void
  onOpenSettings: () => void
}

export function AppHeader({ theme, onHome, onOpenSettings }: AppHeaderProps) {
  const setTheme = useSettings((state) => state.setTheme)
  const dark = theme === 'g100'

  return (
    // The shell header stays dark in both themes, as in most Carbon products.
    <Theme theme="g100">
      <Header aria-label="Urutau">
        <SkipToContent />
        <HeaderName
          href="./"
          prefix=""
          onClick={(event) => {
            event.preventDefault()
            onHome()
          }}
        >
          Urutau
        </HeaderName>
        <HeaderGlobalBar>
          <HeaderGlobalAction
            aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            tooltipAlignment="end"
            onClick={() => setTheme(dark ? 'light' : 'dark')}
          >
            {dark ? <Light size={20} /> : <Asleep size={20} />}
          </HeaderGlobalAction>
          <HeaderGlobalAction aria-label="Settings" tooltipAlignment="end" onClick={onOpenSettings}>
            <Settings size={20} />
          </HeaderGlobalAction>
        </HeaderGlobalBar>
      </Header>
    </Theme>
  )
}
