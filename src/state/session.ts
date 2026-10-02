import { create } from 'zustand'
import { apiRequest, setCsrfToken, setSignedOutHandler } from '../api/client'
import type {
  AcceptInviteRequest,
  AppConfigResponse,
  CredentialsRequest,
  Session,
  SessionResponse,
  SignOutResponse,
} from '../domain/api'

export interface SessionState {
  status: 'loading' | 'signed-out' | 'signed-in'
  /** Meaningful when signed out: true shows "Create the admin account". */
  firstRun: boolean
  session: Session | null
  config: AppConfigResponse | null
  /** Set when the session or config could not be read (server unreachable); null otherwise. */
  loadError: string | null
  /** GET /api/session and GET /api/config. */
  load(): Promise<void>
  signIn(username: string, password: string): Promise<void>
  createAdmin(username: string, password: string): Promise<void>
  acceptInvite(token: string, username: string, password: string): Promise<void>
  /**
   * Re-reads GET /api/session. When it is still the same user, only `session` is replaced (its
   * githubAccess may have changed) and nothing else resets; any other outcome is a session change.
   */
  refresh(): Promise<void>
  /** POST sign-out; follows redirectTo for Keycloak sessions. */
  signOut(): Promise<void>
  /** Called when any /api answer carries code 'signed-out'. Does nothing when already signed out. */
  markSignedOut(): void
}

type Listener = () => void
const listeners = new Set<Listener>()

/**
 * Runs after every session change (sign-in, sign-out, expiry, first load). The boards store
 * resets itself and the query cache is cleared through this, so one user's data never shows
 * under another's session.
 */
export function onSessionChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Replaceable in tests; a real sign-out from Keycloak leaves the page for the end-session URL. */
export const navigation = {
  assign: (url: string) => window.location.assign(url),
}

export const useSession = create<SessionState>()((set, get) => {
  const apply = (patch: Partial<SessionState>) => {
    const session = patch.session === undefined ? get().session : patch.session
    setCsrfToken(session?.csrfToken ?? null)
    set(patch)
    listeners.forEach((listener) => listener())
  }

  const signedIn = (session: Session) =>
    apply({ status: 'signed-in', session, firstRun: false, loadError: null })

  return {
    status: 'loading',
    firstRun: false,
    session: null,
    config: null,
    loadError: null,

    async load() {
      const [sessionResult, configResult] = await Promise.allSettled([
        apiRequest<SessionResponse>('session'),
        apiRequest<AppConfigResponse>('config'),
      ])
      const config = configResult.status === 'fulfilled' ? configResult.value : get().config
      if (sessionResult.status === 'rejected') {
        const reason: unknown = sessionResult.reason
        apply({
          status: 'signed-out',
          firstRun: false,
          session: null,
          config,
          loadError: reason instanceof Error ? reason.message : 'Could not reach the Urutau server.',
        })
        return
      }
      const response = sessionResult.value
      const loadError =
        configResult.status === 'rejected' && configResult.reason instanceof Error
          ? configResult.reason.message
          : null
      if (response.signedIn) {
        apply({ status: 'signed-in', session: response.session, firstRun: false, config, loadError })
      } else {
        apply({ status: 'signed-out', session: null, firstRun: response.firstRun, config, loadError })
      }
    },

    async refresh() {
      let response: SessionResponse
      try {
        response = await apiRequest<SessionResponse>('session')
      } catch {
        return
      }
      const previous = get().session
      if (response.signedIn && previous?.user.id === response.session.user.id) {
        setCsrfToken(response.session.csrfToken)
        set({ session: response.session })
      } else if (response.signedIn) {
        signedIn(response.session)
      } else {
        apply({ status: 'signed-out', session: null, firstRun: response.firstRun, loadError: null })
      }
    },

    async signIn(username, password) {
      const body: CredentialsRequest = { username, password }
      signedIn(await apiRequest<Session>('auth/sign-in', { method: 'POST', body }))
    },

    async createAdmin(username, password) {
      const body: CredentialsRequest = { username, password }
      signedIn(await apiRequest<Session>('auth/first-run', { method: 'POST', body }))
    },

    async acceptInvite(token, username, password) {
      const body: AcceptInviteRequest = { token, username, password }
      signedIn(await apiRequest<Session>('invites/accept', { method: 'POST', body }))
    },

    async signOut() {
      const { redirectTo } = await apiRequest<SignOutResponse>('auth/sign-out', { method: 'POST' })
      apply({ status: 'signed-out', session: null, firstRun: false, loadError: null })
      if (redirectTo) navigation.assign(redirectTo)
    },

    markSignedOut() {
      if (get().status === 'signed-out') return
      apply({ status: 'signed-out', session: null, firstRun: false })
    },
  }
})

setSignedOutHandler(() => useSession.getState().markSignedOut())
