import { Button, Form, InlineNotification, PasswordInput, Stack, TextInput, Tile, Layer } from '@carbon/react'
import { useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import { useSession } from '../../state/session'
import './auth.scss'

interface SignInPageProps {
  /** Shown above the form, e.g. after the session ended or a Keycloak sign-in failed. */
  notice: { kind: 'info' | 'error'; text: string } | null
}

/** Sign in, or "Create the admin account" while the server has no account yet. */
export function SignInPage({ notice }: SignInPageProps) {
  const firstRun = useSession((state) => state.firstRun)
  const loadError = useSession((state) => state.loadError)
  const signIn = useSession((state) => state.signIn)
  const createAdmin = useSession((state) => state.createAdmin)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (firstRun) await createAdmin(username.trim(), password)
      else await signIn(username.trim(), password)
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : 'Something went wrong. Try again.')
      passwordRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  const heading = firstRun ? 'Create the admin account' : 'Sign in to Urutau'

  return (
    <div className="auth">
      <title>{heading} · Urutau</title>
      <div className="auth__intro">
        <h1 className="auth__title">{heading}</h1>
        <p className="auth__lead">
          {firstRun
            ? 'This server has no accounts yet. The account you create here is the administrator and can invite everyone else.'
            : 'Boards on this server are shared with everyone who has an account.'}
        </p>
      </div>

      {notice && (
        <InlineNotification
          role="status"
          kind={notice.kind}
          lowContrast
          hideCloseButton
          title={notice.text}
        />
      )}
      {loadError && (
        <InlineNotification
          role="alert"
          kind="error"
          lowContrast
          hideCloseButton
          title="Could not reach the Urutau server."
          subtitle={loadError}
        />
      )}

      <Tile className="auth__form">
        <Layer>
          <Form onSubmit={(event) => void submit(event)} aria-label={heading} noValidate>
            <Stack gap={6}>
              <TextInput
                id="auth-username"
                labelText="Username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                helperText={
                  firstRun
                    ? '3 to 32 characters: letters, numbers, dots, dashes and underscores.'
                    : undefined
                }
              />
              <PasswordInput
                id="auth-password"
                ref={passwordRef}
                labelText="Password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={firstRun ? 'new-password' : 'current-password'}
                helperText={firstRun ? 'At least 8 characters.' : undefined}
              />
              {error && (
                <InlineNotification
                  role="alert"
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title={error}
                />
              )}
              <div>
                <Button type="submit" disabled={busy || !username.trim() || !password}>
                  {firstRun ? 'Create account' : 'Sign in'}
                </Button>
              </div>
            </Stack>
          </Form>
        </Layer>
      </Tile>
    </div>
  )
}
