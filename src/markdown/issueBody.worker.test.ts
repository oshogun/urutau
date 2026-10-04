import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BodyWorkerMessage, BodyWorkerRequest } from './bodyTree'
import { parseIssueBody } from './issueBody'

const ISSUE_URL = 'https://github.com/acme/widgets/issues/12'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('the body worker entry', () => {
  it('posts ready, then the parsed tree for a request', async () => {
    const addEventListener = vi.spyOn(self, 'addEventListener')
    // jsdom's window.postMessage throws when called with one argument, so the spy does not call through.
    const postMessage = vi.spyOn(self, 'postMessage').mockImplementation(() => {})

    await import('./issueBody.worker')

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'ready' } satisfies BodyWorkerMessage)

    const registered = addEventListener.mock.calls.find(([type]) => type === 'message')
    if (!registered) throw new Error('the worker did not register a message listener')
    const listener = registered[1] as unknown as (event: { data: BodyWorkerRequest }) => void

    const body = '# Title\n\nSome **bold** text and [a link](../wiki/Install).'
    listener({ data: { body, issueUrl: ISSUE_URL } })

    expect(postMessage).toHaveBeenCalledTimes(2)
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'parsed',
      parsed: parseIssueBody(body, ISSUE_URL),
    } satisfies BodyWorkerMessage)
  })
})
