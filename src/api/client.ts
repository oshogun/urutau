import { CSRF_HEADER } from '../domain/api'
import type { ApiErrorBody, ApiErrorCode } from '../domain/api'

/** Thrown for every non-2xx /api response and for network failures (status 0, code 'unavailable'). */
export class ApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  /** Parsed JSON body, e.g. a StaleBoardResponse for 409 'stale-board'. */
  readonly body: unknown

  constructor(status: number, code: ApiErrorCode, message: string, body: unknown = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}

let csrfToken: string | null = null
let signedOutHandler: (() => void) | null = null

/** Set by the session store whenever a session is loaded or cleared. */
export function setCsrfToken(token: string | null): void {
  csrfToken = token
}

/** The session store registers this so any response with code 'signed-out' ends the session. */
export function setSignedOutHandler(handler: (() => void) | null): void {
  signedOutHandler = handler
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** Random per tab, sent as X-Urutau-Client on board saves so a tab can ignore its own events. */
export const CLIENT_ID: string = randomId()

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const CODE_BY_STATUS: Record<number, ApiErrorCode> = {
  400: 'invalid-request',
  401: 'signed-out',
  403: 'forbidden',
  404: 'not-found',
  409: 'stale-board',
  413: 'too-large',
  429: 'too-many-attempts',
  503: 'unavailable',
}

export interface ApiRequestInit {
  method?: string
  body?: unknown
  signal?: AbortSignal
  headers?: Record<string, string>
}

/**
 * fetch wrapper for the urutau server: relative URL `api/<path>` (no leading slash, so the app
 * works under a path prefix), JSON in and out, same-origin cookies, the CSRF header on
 * state-changing methods. It never sends the pasted GitHub token.
 */
export async function apiRequest<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { Accept: 'application/json', ...init.headers }
  if (STATE_CHANGING.has(method)) headers[CSRF_HEADER] = csrfToken ?? '1'

  let body: string | undefined
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.body)
  }

  let response: Response
  try {
    response = await fetch(`api/${path.replace(/^\/+/, '')}`, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: init.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, 'unavailable', 'Could not reach the Urutau server.')
  }

  if (response.status === 204) return undefined as T

  const text = await response.text().catch(() => '')
  let parsed: unknown = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }

  if (!response.ok) {
    const errorBody = parsed as Partial<ApiErrorBody> | null
    const code =
      typeof errorBody?.error === 'string'
        ? errorBody.error
        : (CODE_BY_STATUS[response.status] ?? 'server-error')
    const message =
      typeof errorBody?.message === 'string'
        ? errorBody.message
        : `The Urutau server answered ${response.status}.`
    const error = new ApiError(response.status, code, message, parsed)
    if (code === 'signed-out') signedOutHandler?.()
    throw error
  }

  if (parsed === null && text) {
    throw new ApiError(response.status, 'server-error', 'The Urutau server sent an unreadable answer.')
  }
  return parsed as T
}
