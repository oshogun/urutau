import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { formatRepo, parseRepoInput } from '../domain/repoRef'
import type { RepoRef } from '../domain/types'

function subscribe(onChange: () => void) {
  window.addEventListener('popstate', onChange)
  return () => window.removeEventListener('popstate', onChange)
}

const getSearch = () => window.location.search

/**
 * The repository in the `?repo=owner/name` query parameter. Keeping it in the
 * URL makes boards bookmarkable and works on static hosts without rewrites.
 */
export function useRepoParam() {
  const search = useSyncExternalStore(subscribe, getSearch)
  const repo = useMemo(() => {
    const value = new URLSearchParams(search).get('repo')
    return value ? parseRepoInput(value) : null
  }, [search])

  const navigate = useCallback((next: RepoRef | null) => {
    const url = new URL(window.location.href)
    url.search = next ? `?repo=${formatRepo(next)}` : ''
    window.history.pushState(null, '', url)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, [])

  return [repo, navigate] as const
}
