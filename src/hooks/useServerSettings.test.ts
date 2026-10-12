import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { SERVER_SETTINGS_QUERY_KEY } from '../api/settings'
import { useSession } from '../state/session'
import { installApiStub } from '../test/apiStub'
import { useServerSettings, useUpdateServerSettings } from './useServerSettings'

const ALL_OFF = { createIssues: false, editIssues: false }
const ALL_ON = { createIssues: true, editIssues: true }

function setup() {
  const queryClient = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children)
  return { queryClient, wrapper }
}

beforeEach(() => {
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
})

describe('useServerSettings', () => {
  it('reads every kind off while loading, then the server values', async () => {
    const stub = installApiStub({ githubWrites: { editIssues: true } })
    await useSession.getState().load()
    const { result } = renderHook(() => useServerSettings(), { wrapper: setup().wrapper })
    expect(result.current).toMatchObject({ githubWrites: ALL_OFF, isLoading: true })
    await waitFor(() => expect(result.current.githubWrites).toEqual({ createIssues: false, editIssues: true }))
    expect(stub.requests('GET settings')).toHaveLength(1)
  })

  it('reads every kind off when the request fails, without retrying', async () => {
    const stub = installApiStub({ githubWrites: true })
    await useSession.getState().load()
    stub.failNext('GET settings', { status: 500, error: 'server-error' }, 3)
    const { result } = renderHook(() => useServerSettings(), { wrapper: setup().wrapper })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.githubWrites).toEqual(ALL_OFF)
    expect(stub.requests('GET settings')).toHaveLength(1)
  })

  it('reads every kind off from a server that has no settings route', async () => {
    const stub = installApiStub({ githubWrites: true })
    await useSession.getState().load()
    stub.failNext('GET settings', { status: 404, error: 'not-found' })
    const { result } = renderHook(() => useServerSettings(), { wrapper: setup().wrapper })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.githubWrites).toEqual(ALL_OFF)
  })
})

describe('useUpdateServerSettings', () => {
  it("sends the change and writes the server's answer into the cache", async () => {
    const stub = installApiStub()
    await useSession.getState().load()
    const { queryClient, wrapper } = setup()
    const { result } = renderHook(() => useUpdateServerSettings(), { wrapper })
    await act(() => result.current.update({ githubWrites: { createIssues: true } }))
    expect(stub.githubWrites).toEqual({ createIssues: true, editIssues: false })
    expect(stub.requests('PATCH settings')[0].body).toEqual({ githubWrites: { createIssues: true } })
    expect(queryClient.getQueryData(SERVER_SETTINGS_QUERY_KEY)).toEqual({ githubWrites: { createIssues: true, editIssues: false } })
    await act(() => result.current.update({ githubWrites: { editIssues: true } }))
    expect(queryClient.getQueryData(SERVER_SETTINGS_QUERY_KEY)).toEqual({ githubWrites: ALL_ON })
  })

  it('reports a non-admin refusal as an error', async () => {
    installApiStub({ user: { isAdmin: false } })
    await useSession.getState().load()
    const { result } = renderHook(() => useUpdateServerSettings(), { wrapper: setup().wrapper })
    await act(() => result.current.update({ githubWrites: { createIssues: true } }).catch(() => undefined))
    await waitFor(() => expect(result.current.error).not.toBeNull())
  })
})
