// Runs the body parser in a dedicated Web Worker, so markdown-it never runs on the main thread.
// The main thread posts the body, waits at most BODY_PARSE_TIMEOUT_MS after the worker says it is
// ready, and terminates the worker when the tree arrives, when the time runs out, on an error, or
// when the caller aborts. Terminating a worker does not stop a parse that is already running: the
// browser lets the worker's script run on its own thread until it returns or is stopped, and
// anything the worker posts after `terminate()` is dropped.
import { BODY_RENDER_LIMIT } from './bodyTree.ts'
import type { BodyWorkerMessage, BodyWorkerRequest, ParsedBody } from './bodyTree.ts'

/** How long the worker may take to parse one body, counted from its `ready` message. */
export const BODY_PARSE_TIMEOUT_MS = 1_000

/** How long the worker may take to load (fetch and run its module) and post `ready`. */
export const BODY_WORKER_LOAD_TIMEOUT_MS = 10_000

/**
 * - `parsed`: the worker returned the tree.
 * - `timed-out`: no tree within BODY_PARSE_TIMEOUT_MS of `ready`; the worker was terminated.
 * - `failed`: the worker could not be created, did not post `ready` within
 *   BODY_WORKER_LOAD_TIMEOUT_MS, raised an `error` or `messageerror` event, or posted a message
 *   out of order; the worker was terminated.
 * - `aborted`: the caller's signal was aborted first; the worker was terminated.
 */
export type BodyParseOutcome =
  | { status: 'parsed'; parsed: ParsedBody }
  | { status: 'timed-out' }
  | { status: 'failed' }
  | { status: 'aborted' }

/** The part of the DOM `Worker` the wrapper uses. Tests pass a fake that implements it. */
export interface BodyWorkerLike {
  postMessage(message: BodyWorkerRequest): void
  terminate(): void
  onmessage: ((event: MessageEvent<BodyWorkerMessage>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent) => void) | null
}

// Vite bundles a worker only when the constructor is written with a literal path in exactly this form.
export function createBodyWorker(): BodyWorkerLike {
  return new Worker(new URL('./issueBody.worker.ts', import.meta.url), { type: 'module' })
}

export interface ParseBodyOptions {
  /** Aborting it terminates the worker and settles the promise as `aborted`. */
  signal: AbortSignal
  /** Tests only. Default `createBodyWorker`. */
  createWorker?: () => BodyWorkerLike
  /** Tests only. Default BODY_PARSE_TIMEOUT_MS. */
  parseTimeoutMs?: number
  /** Tests only. Default BODY_WORKER_LOAD_TIMEOUT_MS. */
  loadTimeoutMs?: number
}

/**
 * Parses `body` in a new worker (one worker per call). Never rejects and settles exactly once.
 * Every way of settling clears its timer, terminates the worker and removes the abort listener,
 * and any event after that is ignored. There is no main-thread fallback: without a worker the
 * caller shows the body as plain text.
 */
export function parseBodyInWorker(
  body: string,
  issueUrl: string,
  {
    signal,
    createWorker = createBodyWorker,
    parseTimeoutMs = BODY_PARSE_TIMEOUT_MS,
    loadTimeoutMs = BODY_WORKER_LOAD_TIMEOUT_MS,
  }: ParseBodyOptions,
): Promise<BodyParseOutcome> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ status: 'aborted' })
      return
    }
    let worker: BodyWorkerLike | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let posted = false

    const finish = (outcome: BodyParseOutcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (worker) {
        worker.onmessage = null
        worker.onerror = null
        worker.onmessageerror = null
        worker.terminate()
      }
      resolve(outcome)
    }
    const onAbort = () => finish({ status: 'aborted' })
    signal.addEventListener('abort', onAbort)

    try {
      worker = createWorker()
    } catch {
      finish({ status: 'failed' })
      return
    }
    const current = worker
    timer = setTimeout(() => finish({ status: 'failed' }), loadTimeoutMs)
    current.onmessage = (event) => {
      if (settled) return
      const data = event.data as BodyWorkerMessage | null
      if (data?.type === 'ready' && !posted) {
        clearTimeout(timer)
        posted = true
        try {
          current.postMessage({ body: body.slice(0, BODY_RENDER_LIMIT + 1), issueUrl })
        } catch {
          finish({ status: 'failed' })
          return
        }
        timer = setTimeout(() => finish({ status: 'timed-out' }), parseTimeoutMs)
      } else if (data?.type === 'parsed' && posted && typeof data.parsed === 'object' && data.parsed !== null) {
        finish({ status: 'parsed', parsed: data.parsed })
      } else {
        finish({ status: 'failed' })
      }
    }
    current.onerror = (event) => {
      event.preventDefault()
      finish({ status: 'failed' })
    }
    current.onmessageerror = () => finish({ status: 'failed' })
  })
}
