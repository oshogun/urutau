import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { ApiErrorCode } from '../../src/domain/api.ts'

export interface HttpErrorOptions {
  /** Fields added to the JSON error body, such as `current` on a stale board. */
  extra?: Record<string, unknown>
  headers?: Record<string, string>
}

/** An error the app turns into a JSON `ApiErrorBody` response. */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode
  readonly code: ApiErrorCode
  readonly extra: Record<string, unknown>
  readonly headers: Record<string, string>

  constructor(status: ContentfulStatusCode, code: ApiErrorCode, message: string, options: HttpErrorOptions = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.extra = options.extra ?? {}
    this.headers = options.headers ?? {}
  }
}

export function invalidRequest(message: string): HttpError {
  return new HttpError(400, 'invalid-request', message)
}
