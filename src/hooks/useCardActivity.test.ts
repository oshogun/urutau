import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useActivity } from '../state/activityStore'
import { useSession } from '../state/session'
import { installApiStub } from '../test/apiStub'
import type { ApiStub } from '../test/apiStub'
import { makeClaim, makeRunDetail } from '../test/fixtures'
import { useBoardActivity, useIssueActivity } from './useCardActivity'

const REPO = { owner: 'acme', name: 'widgets' }
const KEY = 'acme/widgets'
let stub: ApiStub

beforeEach(async () => {
  useActivity.setState({ boards: {}, issues: {} })
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
  stub = installApiStub()
  await useSession.getState().load()
})

describe('useBoardActivity', () => {
  it('loads once on mount and returns the cards by issue number', async () => {
    stub.setActivity(KEY, 3, { claim: makeClaim('r-1'), runs: [makeRunDetail('r-1')] })
    const { result, rerender } = renderHook(() => useBoardActivity(REPO))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.cards.get(3)?.claim?.runId).toBe('r-1')
    rerender()
    expect(stub.requests('GET boards/acme/widgets/activity')).toHaveLength(1)
  })

  it('shows a card change that arrives after mount', async () => {
    const { result } = renderHook(() => useBoardActivity(REPO))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    stub.setActivity(KEY, 4, { claim: makeClaim('r-4'), runs: [makeRunDetail('r-4')] })
    await act(() => useActivity.getState().refreshIssue(KEY, 4))
    expect(result.current.cards.get(4)?.claim?.runId).toBe('r-4')
  })
})

describe('useIssueActivity', () => {
  it('fetches the issue on mount and releases through the store', async () => {
    stub.setActivity(KEY, 3, { claim: makeClaim('r-1'), runs: [makeRunDetail('r-1')] })
    const { result } = renderHook(() => useIssueActivity(REPO, 3))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.data?.claim?.runId).toBe('r-1')
    await act(() => result.current.release('r-1'))
    expect(result.current.data?.claim).toBeNull()
  })

  it('reports a failed fetch as an error', async () => {
    stub.failNext('GET boards/acme/widgets/activity/3', { status: 500, error: 'server-error', message: 'Boom.' })
    const { result } = renderHook(() => useIssueActivity(REPO, 3))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toBe('Boom.')
  })
})
