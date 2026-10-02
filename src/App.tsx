import { GlobalTheme } from '@carbon/react'
import { useState } from 'react'
import { BoardPage } from './board/BoardPage'
import { AppHeader } from './components/AppHeader'
import { ConnectPage } from './components/ConnectPage'
import { SettingsModal } from './components/SettingsModal'
import { repoKey } from './domain/repoRef'
import { useCarbonTheme, useDocumentTheme } from './hooks/useCarbonTheme'
import { useRepoParam } from './hooks/useRepoParam'

export function App() {
  const theme = useCarbonTheme()
  useDocumentTheme(theme)
  const [repo, navigate] = useRepoParam()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const openSettings = () => setSettingsOpen(true)

  return (
    <GlobalTheme theme={theme}>
      <AppHeader theme={theme} onHome={() => navigate(null)} onOpenSettings={openSettings} />
      <main id="main-content" className="app-main">
        {repo ? (
          <BoardPage
            key={repoKey(repo)}
            repo={repo}
            onOpenSettings={openSettings}
            onChangeRepo={() => navigate(null)}
          />
        ) : (
          <ConnectPage onOpen={navigate} />
        )}
      </main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </GlobalTheme>
  )
}
