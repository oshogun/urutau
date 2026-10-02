import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSession } from '../state/session'
import { useSettings } from '../state/settings'
import { installApiStub } from '../test/apiStub'
import { useRepoSnapshot } from './useRepoSnapshot'

const REPO = { owner: 'acme', name: 'widgets' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const repository = {
  full_name: 'acme/widgets',
  description: null,
  html_url: 'https://github.com/acme/widgets',
  private: false,
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
}

function githubByPath(path: string) {
  if (path.endsWith('/labels') || path.includes('/issues')) return json([])
  return json(repository)
}

beforeEach(() => {
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
  useSettings.setState({ token: 'ghp_pasted_secret' })
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (url) => githubByPath(new URL(String(url)).pathname)),
  )
})

describe('useRepoSnapshot', () => {
  it('reads from api.github.com with the pasted token in browser mode', async () => {
    installApiStub()
    await useSession.getState().load()
    vi.mocked(fetch).mockClear()
    const { result } = renderHook(() => useRepoSnapshot(REPO, 0), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data).toBeDefined())
    const calls = vi.mocked(fetch).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (const [url, init] of calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.github\.com\//)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ghp_pasted_secret')
    }
  })

  it('reads through api/github without the token in server mode', async () => {
    const stub = installApiStub({
      githubAccess: { mode: 'server' },
      github: ({ path }) => githubByPath(path),
    })
    await useSession.getState().load()
    vi.mocked(fetch).mockClear()
    const { result } = renderHook(() => useRepoSnapshot(REPO, 0), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.data).toBeDefined())
    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
    expect(urls.every((url) => url.startsWith('api/github/'))).toBe(true)
    const githubCalls = stub.requests((call) => call.path.startsWith('github/'))
    expect(githubCalls.length).toBe(urls.length)
    for (const call of githubCalls) expect(Object.keys(call.headers)).not.toContain('authorization')
  })

  it('on a 424 reloads the session and falls back to the browser path', async () => {
    const stub = installApiStub({
      githubAccess: { mode: 'server' },
      github: () => json({ error: 'github-access', message: 'x', problem: 'signin-expired' }, 424),
    })
    await useSession.getState().load()
    vi.mocked(fetch).mockClear()
    const { result } = renderHook(() => useRepoSnapshot(REPO, 0), { wrapper: wrapper() })
    await waitFor(() => expect(result.current.error).toMatchObject({ kind: 'server-access' }))
    stub.setGithubAccess({ mode: 'browser', problem: 'signin-expired' })
    await useSession.getState().refresh()
    await waitFor(() => expect(result.current.data?.repository.fullName).toBe('acme/widgets'))
    expect(useSession.getState().session?.githubAccess).toEqual({ mode: 'browser', problem: 'signin-expired' })
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith('https://api.github.com/'))).toBe(true)
  })
})
