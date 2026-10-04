import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BODY_RENDER_LIMIT,
  type BodyWorkerMessage,
  type BodyWorkerRequest,
  type ParsedBody,
} from './bodyTree'
import {
  BODY_PARSE_TIMEOUT_MS,
  BODY_WORKER_LOAD_TIMEOUT_MS,
  createBodyWorker,
  parseBodyInWorker,
  type BodyWorkerLike,
} from './parseBodyInWorker'

const ISSUE_URL = 'https://github.com/acme/widgets/issues/12'
const TREE: ParsedBody = { blocks: [{ type: 'rule' }], omittedHtml: false, truncated: false, tablesAsText: false }

class FakeWorker implements BodyWorkerLike {
  posted: BodyWorkerRequest[] = []
  terminate = vi.fn()
  onmessage: BodyWorkerLike['onmessage'] = null
  onerror: BodyWorkerLike['onerror'] = null
  onmessageerror: BodyWorkerLike['onmessageerror'] = null

  postMessage(message: BodyWorkerRequest) {
    this.posted.push(message)
  }

  say(message: unknown) {
    this.onmessage?.({ data: message } as MessageEvent<BodyWorkerMessage>)
  }
}

function setup(body = 'hello') {
  const worker = new FakeWorker()
  const createWorker = vi.fn(() => worker)
  const controller = new AbortController()
  const outcome = parseBodyInWorker(body, ISSUE_URL, { signal: controller.signal, createWorker })
  return { worker, createWorker, controller, outcome }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('parseBodyInWorker', () => {
  it('settles failed and terminates once when postMessage throws', async () => {
    const { worker, outcome } = setup()
    worker.postMessage = () => {
      throw new Error('clone failed')
    }
    worker.say({ type: 'ready' })
    await expect(outcome).resolves.toEqual({ status: 'failed' })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('settles failed and terminates once when the body cannot be sliced', async () => {
    const { worker, outcome } = setup(null as unknown as string)
    worker.say({ type: 'ready' })
    await expect(outcome).resolves.toEqual({ status: 'failed' })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('settles failed when the parsed message carries no object', async () => {
    const { worker, outcome } = setup()
    worker.say({ type: 'ready' })
    worker.say({ type: 'parsed', parsed: undefined })
    await expect(outcome).resolves.toEqual({ status: 'failed' })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('settles parsed with the tree and terminates the worker once', async () => {
    const { worker, outcome } = setup()
    worker.say({ type: 'ready' })
    worker.say({ type: 'parsed', parsed: TREE })
    await expect(outcome).resolves.toEqual({ status: 'parsed', parsed: TREE })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(worker.posted).toEqual([{ body: 'hello', issueUrl: ISSUE_URL }])
  })

  it('posts at most BODY_RENDER_LIMIT + 1 units of a long body', () => {
    const { worker } = setup('x'.repeat(200_000))
    worker.say({ type: 'ready' })
    expect(worker.posted).toHaveLength(1)
    expect(worker.posted[0].body.length).toBe(BODY_RENDER_LIMIT + 1)
    expect(worker.posted[0].issueUrl).toBe(ISSUE_URL)
  })

  it('settles timed-out at exactly the parse limit after ready', async () => {
    const { worker, outcome } = setup()
    const settled = vi.fn()
    void outcome.then(settled)
    worker.say({ type: 'ready' })
    await vi.advanceTimersByTimeAsync(BODY_PARSE_TIMEOUT_MS - 1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(outcome).resolves.toEqual({ status: 'timed-out' })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('uses the limits it is given', async () => {
    const worker = new FakeWorker()
    const outcome = parseBodyInWorker('a', ISSUE_URL, {
      signal: new AbortController().signal,
      createWorker: () => worker,
      parseTimeoutMs: 50,
      loadTimeoutMs: 20,
    })
    await vi.advanceTimersByTimeAsync(20)
    await expect(outcome).resolves.toEqual({ status: 'failed' })
  })

  it('settles failed when ready never comes within the load limit', async () => {
    const { worker, outcome } = setup()
    await vi.advanceTimersByTimeAsync(BODY_WORKER_LOAD_TIMEOUT_MS)
    await expect(outcome).resolves.toEqual({ status: 'failed' })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(worker.posted).toEqual([])
  })

  it('does not run the load timer once ready came', async () => {
    const worker = new FakeWorker()
    const outcome = parseBodyInWorker('a', ISSUE_URL, {
      signal: new AbortController().signal,
      createWorker: () => worker,
      loadTimeoutMs: 500,
      parseTimeoutMs: 5_000,
    })
    worker.say({ type: 'ready' })
    await vi.advanceTimersByTimeAsync(600)
    worker.say({ type: 'parsed', parsed: TREE })
    await expect(outcome).resolves.toEqual({ status: 'parsed', parsed: TREE })
  })

  it('settles failed on an error event and prevents its default', async () => {
    const { worker, outcome } = setup()
    const preventDefault = vi.fn()
    worker.onerror?.({ preventDefault } as unknown as ErrorEvent)
    await expect(outcome).resolves.toEqual({ status: 'failed' })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('settles failed on a messageerror event', async () => {
    const { worker, outcome } = setup()
    worker.onmessageerror?.({} as MessageEvent)
    await expect(outcome).resolves.toEqual({ status: 'failed' })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('settles failed when parsed arrives before ready', async () => {
    const { worker, outcome } = setup()
    worker.say({ type: 'parsed', parsed: TREE })
    await expect(outcome).resolves.toEqual({ status: 'failed' })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it.each([[{ type: 'surprise' }], [null], ['ready']])('settles failed on the unknown message %j', async (message) => {
    const { worker, outcome } = setup()
    worker.say(message)
    await expect(outcome).resolves.toEqual({ status: 'failed' })
  })

  it('settles failed on a second ready', async () => {
    const { worker, outcome } = setup()
    worker.say({ type: 'ready' })
    worker.say({ type: 'ready' })
    await expect(outcome).resolves.toEqual({ status: 'failed' })
    expect(worker.posted).toHaveLength(1)
  })

  it('settles aborted and terminates the worker when the signal aborts', async () => {
    const { worker, controller, outcome } = setup()
    worker.say({ type: 'ready' })
    controller.abort()
    await expect(outcome).resolves.toEqual({ status: 'aborted' })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('creates no worker for a signal that is already aborted', async () => {
    const createWorker = vi.fn(() => new FakeWorker())
    const controller = new AbortController()
    controller.abort()
    await expect(parseBodyInWorker('a', ISSUE_URL, { signal: controller.signal, createWorker })).resolves.toEqual({
      status: 'aborted',
    })
    expect(createWorker).not.toHaveBeenCalled()
  })

  it('settles failed when the worker cannot be created', async () => {
    const outcome = parseBodyInWorker('a', ISSUE_URL, {
      signal: new AbortController().signal,
      createWorker: () => {
        throw new Error('no Worker')
      },
    })
    await expect(outcome).resolves.toEqual({ status: 'failed' })
  })

  it('settles failed with the default factory in jsdom, which has no Worker', async () => {
    await expect(parseBodyInWorker('a', ISSUE_URL, { signal: new AbortController().signal })).resolves.toEqual({
      status: 'failed',
    })
    expect(() => createBodyWorker()).toThrow()
  })

  it('ignores a parsed message after timed-out, and terminates once in all', async () => {
    const { worker, outcome } = setup()
    worker.say({ type: 'ready' })
    await vi.advanceTimersByTimeAsync(BODY_PARSE_TIMEOUT_MS)
    await expect(outcome).resolves.toEqual({ status: 'timed-out' })
    worker.say({ type: 'parsed', parsed: TREE })
    await vi.advanceTimersByTimeAsync(BODY_WORKER_LOAD_TIMEOUT_MS)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('removes its handlers and abort listener once settled', async () => {
    const { worker, controller, outcome } = setup()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    worker.say({ type: 'ready' })
    worker.say({ type: 'parsed', parsed: TREE })
    await outcome
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(worker.onmessage).toBeNull()
    expect(worker.onerror).toBeNull()
    expect(worker.onmessageerror).toBeNull()
  })
})
