import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SERVER_SETTINGS_QUERY_KEY } from '../api/settings'
import { useSession } from '../state/session'
import { installApiStub } from '../test/apiStub'
import { useServerSettings, useUpdateServerSettings } from './useServerSettings'

function setup() {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children)
  return { queryClient, wrapper }
}

beforeEach(() => {
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
})

describe('useServerSettings', () => {
  it('reads false while loading, then the server value', async () => {
    const stub = installApiStub({ githubWrites: true })
    await useSession.getState().load()
    const { result } = renderHook(() => useServerSettings(), { wrapper: setup().wrapper })
    expect(result.current).toMatchObject({ githubWrites: false, isLoading: true })
    await waitFor(() => expect(result.current.githubWrites).toBe(true))
    expect(stub.requests('GET settings')).toHaveLength(1)
  })

  it('reads false when the request fails, without retrying', async () => {
    const stub = installApiStub({ githubWrites: true })
    await useSession.getState().load()
    stub.failNext('GET settings', { status: 500, error: 'server-error' }, 3)
    const { result } = renderHook(() => useServerSettings(), { wrapper: setup().wrapper })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.githubWrites).toBe(false)
    expect(stub.requests('GET settings')).toHaveLength(1)
  })

  it('reads false from a server that has no settings route', async () => {
    const stub = installApiStub({ githubWrites: true })
    await useSession.getState().load()
    stub.failNext('GET settings', { status: 404, error: 'not-found' })
    const { result } = renderHook(() => useServerSettings(), { wrapper: setup().wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.githubWrites).toBe(false)
  })
})

describe('useUpdateServerSettings', () => {
  it("sends the change and writes the server's answer into the cache", async () => {
    const stub = installApiStub()
    await useSession.getState().load()
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => useUpdateServerSettings(), { wrapper })
    await act(() => result.current.update({ githubWrites: true }))
    expect(stub.githubWrites).toBe(true)
    expect(stub.requests('PATCH settings')[0].body).toEqual({ githubWrites: true })
    expect(queryClient.getQueryData(SERVER_SETTINGS_QUERY_KEY)).toEqual({ githubWrites: true })
  })

  it('reports a non-admin refusal as an error', async () => {
    installApiStub({ user: { isAdmin: false } })
    await useSession.getState().load()
    const { result } = renderHook(() => useUpdateServerSettings(), { wrapper: setup().wrapper })
    await act(() => result.current.update({ githubWrites: true }).catch(() => undefined))
    await waitFor(() => expect(result.current.error).not.toBeNull())
  })
})
