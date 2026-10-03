import { GlobalTheme, InlineLoading, ToastNotification } from '@carbon/react'
import { useEffect, useRef, useState } from 'react'
import { BoardPage } from './board/BoardPage'
import { AppHeader } from './components/AppHeader'
import { InvitePage } from './components/auth/InvitePage'
import { SignInPage } from './components/auth/SignInPage'
import { signinErrorMessage } from './components/auth/signinMessages'
import { useEntryParams, useViewParam } from './components/auth/useEntryParams'
import { ServerSettingsPage } from './components/auth/ServerSettingsPage'
import { UsersPage } from './components/auth/UsersPage'
import { ConnectPage } from './components/ConnectPage'
import { SettingsModal } from './components/SettingsModal'
import { repoKey } from './domain/repoRef'
import { useCarbonTheme, useDocumentTheme } from './hooks/useCarbonTheme'
import { useRepoParam } from './hooks/useRepoParam'
import { useSession } from './state/session'

export function App() {
  const theme = useCarbonTheme()
  useDocumentTheme(theme)
  const [repo, navigate] = useRepoParam()
  const { view, openUsers, openServerSettings } = useViewParam()
  const { inviteToken, signinError, clearInvite, clearSigninError } = useEntryParams()
  const status = useSession((state) => state.status)
  const isAdmin = useSession((state) => state.session?.user.isAdmin ?? false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [headerError, setHeaderError] = useState<string | null>(null)
  const [sessionEnded, setSessionEnded] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  const [signedOutByUser, setSignedOutByUser] = useState(false)
  const openSettings = () => setSettingsOpen(true)

  // Once per page load: StrictMode runs effects twice in development, and a second load would
  // clear the query cache under the start page's already-running board list request.
  const loadStarted = useRef(false)
  useEffect(() => {
    if (loadStarted.current) return
    loadStarted.current = true
    void useSession.getState().load()
  }, [])

  // Adjust state while rendering, when the session status changes, instead of in an effect.
  const [seenStatus, setSeenStatus] = useState(status)
  if (seenStatus !== status) {
    setSeenStatus(status)
    if (seenStatus === 'signed-in' && status === 'signed-out' && !signedOutByUser) setSessionEnded(true)
    if (status === 'signed-in') {
      setSignedOutByUser(false)
      setSessionEnded(false)
      setSettingsOpen(false)
      clearSigninError()
    }
  }

  const wasSignedOut = useRef(false)
  useEffect(() => {
    if (status === 'signed-in' && wasSignedOut.current) mainRef.current?.focus()
    wasSignedOut.current = status === 'signed-out'
  }, [status])

  const notice = sessionEnded
    ? { kind: 'info' as const, text: 'Your session ended; your last change was not saved.' }
    : signinError
      ? { kind: 'error' as const, text: signinErrorMessage(signinError) }
      : null

  const signOut = () => {
    setSignedOutByUser(true)
    return useSession
      .getState()
      .signOut()
      .catch((failure: unknown) => {
        setSignedOutByUser(false)
        setHeaderError(failure instanceof Error ? failure.message : 'Try again.')
      })
  }

  const goHome = () => {
    clearInvite()
    navigate(null)
  }

  let content
  if (status === 'loading') {
    content = (
      <div className="app-loading">
        <InlineLoading description="Loading Urutau" />
      </div>
    )
  } else if (inviteToken) {
    content = <InvitePage token={inviteToken} onDone={clearInvite} onSignOut={signOut} />
  } else if (status === 'signed-out') {
    content = <SignInPage notice={notice} />
  } else if (repo) {
    content = (
      <BoardPage
        key={repoKey(repo)}
        repo={repo}
        onOpenSettings={openSettings}
        onChangeRepo={() => navigate(null)}
      />
    )
  } else if (view === 'users' && isAdmin) {
    content = <UsersPage />
  } else if (view === 'server-settings' && isAdmin) {
    content = <ServerSettingsPage />
  } else {
    content = <ConnectPage onOpen={navigate} />
  }

  return (
    <GlobalTheme theme={theme}>
      <AppHeader
        theme={theme}
        onHome={goHome}
        onOpenSettings={openSettings}
        onOpenUsers={openUsers}
        onOpenServerSettings={openServerSettings}
        onSignOut={signOut}
      />
      <main id="main-content" className="app-main" ref={mainRef} tabIndex={-1}>
        {content}
      </main>
      {headerError && (
        <ToastNotification
          className="app-toast"
          role="alert"
          kind="error"
          title="Could not sign out"
          subtitle={headerError}
          timeout={6000}
          onClose={() => {
            setHeaderError(null)
            return true
          }}
        />
      )}
      {settingsOpen && status === 'signed-in' && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </GlobalTheme>
  )
}
