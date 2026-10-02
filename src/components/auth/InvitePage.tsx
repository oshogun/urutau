import {
  Button,
  Form,
  InlineLoading,
  InlineNotification,
  Layer,
  PasswordInput,
  Stack,
  TextInput,
  Tile,
} from '@carbon/react'
import { useQuery } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { checkInvite } from '../../api/invites'
import { ApiError } from '../../api/client'
import { useSession } from '../../state/session'
import { formatDateTime } from './format'
import './auth.scss'

interface InvitePageProps {
  token: string
  /** Leaves the invite page (after accepting it, or to go to the sign-in page). */
  onDone: () => void
  onSignOut: () => Promise<void>
}

export function InvitePage({ token, onDone, onSignOut }: InvitePageProps) {
  const status = useSession((state) => state.status)
  const user = useSession((state) => state.session?.user)
  const acceptInvite = useSession((state) => state.acceptInvite)

  const [busy, setBusy] = useState(false)

  // Disabled while the invite is being accepted: the session change resets the queries, and a
  // refetch would send the already-used token again.
  const check = useQuery({
    queryKey: ['invite-check', token],
    queryFn: () => checkInvite(token),
    enabled: status === 'signed-out' && !busy,
    retry: false,
    staleTime: Infinity,
  })

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [usernameTaken, setUsernameTaken] = useState(false)
  const usernameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setUsernameTaken(false)
    try {
      await acceptInvite(token, username.trim(), password)
      onDone()
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'username-taken') {
        setUsernameTaken(true)
        usernameRef.current?.focus()
      } else {
        setError(failure instanceof ApiError ? failure.message : 'Something went wrong. Try again.')
        passwordRef.current?.focus()
      }
    } finally {
      setBusy(false)
    }
  }

  let body
  if (status === 'signed-in') {
    body = (
      <>
        <InlineNotification
          role="status"
          kind="info"
          lowContrast
          hideCloseButton
          title={`Signed in as ${user?.username ?? ''}.`}
          subtitle="Sign out to accept this invite."
        />
        <div className="auth__actions">
          <Button kind="primary" onClick={() => void onSignOut()}>
            Sign out
          </Button>
          <Button kind="ghost" onClick={onDone}>
            Back to boards
          </Button>
        </div>
      </>
    )
  } else if (check.isPending) {
    body = <InlineLoading description="Checking the invite link" />
  } else if (check.isError) {
    const invalid = check.error instanceof ApiError && check.error.code === 'invite-invalid'
    body = (
      <>
        <InlineNotification
          role="alert"
          kind="error"
          lowContrast
          hideCloseButton
          title={invalid ? 'This invite link is not valid any more.' : 'Could not check the invite link.'}
          subtitle={
            invalid
              ? 'It may have been used, revoked or expired. Ask the administrator for a new one.'
              : check.error.message
          }
        />
        <div className="auth__actions">
          {!invalid && (
            <Button kind="tertiary" onClick={() => void check.refetch()}>
              Try again
            </Button>
          )}
          <Button kind="ghost" onClick={onDone}>
            Go to sign in
          </Button>
        </div>
      </>
    )
  } else {
    body = (
      <Tile className="auth__form">
        <Layer>
          <Form onSubmit={(event) => void submit(event)} aria-label="Accept the invite" noValidate>
            <Stack gap={6}>
              <TextInput
                id="invite-username"
                ref={usernameRef}
                labelText="Username"
                helperText="3 to 32 characters: letters, numbers, dots, dashes and underscores."
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                invalid={usernameTaken}
                invalidText="That username is taken. Choose another."
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
              <PasswordInput
                id="invite-password"
                ref={passwordRef}
                labelText="Password"
                helperText="At least 8 characters."
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
              />
              {error && (
                <InlineNotification role="alert" kind="error" lowContrast hideCloseButton title={error} />
              )}
              <div>
                <Button type="submit" disabled={busy || !username.trim() || !password}>
                  Create account
                </Button>
              </div>
            </Stack>
          </Form>
        </Layer>
      </Tile>
    )
  }

  return (
    <div className="auth">
      <title>Accept the invite · Urutau</title>
      <div className="auth__intro">
        <h1 className="auth__title">You are invited to Urutau</h1>
        <p className="auth__lead">
          {check.data
            ? `Choose a username and password. This link works until ${formatDateTime(check.data.expiresAt)}.`
            : 'Choose a username and password to join the boards on this server.'}
        </p>
      </div>
      {body}
    </div>
  )
}
