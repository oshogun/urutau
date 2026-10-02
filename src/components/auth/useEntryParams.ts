import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

const INVITE_PREFIX = '#invite='

function readInvite(): string | null {
  const hash = window.location.hash
  if (!hash.startsWith(INVITE_PREFIX)) return null
  let token: string
  try {
    token = decodeURIComponent(hash.slice(INVITE_PREFIX.length)).trim()
  } catch {
    // A malformed escape cannot be a token the server issued; the invite page reports it as invalid.
    token = hash.slice(INVITE_PREFIX.length).trim()
  }
  return token || null
}

function readSigninError(): string | null {
  return new URLSearchParams(window.location.search).get('signin-error')
}

export interface EntryParams {
  /** Token from `#invite=<token>`; kept after the fragment is removed from the address bar. */
  inviteToken: string | null
  /** Code from `?signin-error=<code>`, kept after it is removed from the address bar. */
  signinError: string | null
  clearInvite: () => void
  clearSigninError: () => void
}

/**
 * Reads the invite fragment and the sign-in error parameter once, then removes them from the
 * address bar so a reload or a copied URL does not repeat them.
 */
export function useEntryParams(): EntryParams {
  const [inviteToken, setInviteToken] = useState(readInvite)
  const [signinError, setSigninError] = useState(readSigninError)

  useEffect(() => {
    function consume() {
      const invite = readInvite()
      const error = readSigninError()
      if (invite === null && error === null) return
      if (invite !== null) setInviteToken(invite)
      if (error !== null) setSigninError(error)
      const url = new URL(window.location.href)
      if (invite !== null) url.hash = ''
      if (error !== null) url.searchParams.delete('signin-error')
      window.history.replaceState(null, '', url)
    }
    consume()
    window.addEventListener('hashchange', consume)
    return () => window.removeEventListener('hashchange', consume)
  }, [])

  const clearInvite = useCallback(() => setInviteToken(null), [])
  const clearSigninError = useCallback(() => setSigninError(null), [])
  return { inviteToken, signinError, clearInvite, clearSigninError }
}

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange)
  return () => window.removeEventListener('popstate', onChange)
}

const getSearch = () => window.location.search

/** The `?view=` query parameter; only `users` is defined. */
export function useViewParam() {
  const search = useSyncExternalStore(subscribe, getSearch)
  const view = new URLSearchParams(search).get('view')
  const openUsers = useCallback(() => {
    const url = new URL(window.location.href)
    url.search = '?view=users'
    window.history.pushState(null, '', url)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, [])
  return { view, openUsers }
}
