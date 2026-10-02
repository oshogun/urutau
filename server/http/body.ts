import type { Context, MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HttpError, invalidRequest } from './errors.ts'

const DEFAULT_LIMIT = 1024 * 1024
const IMPORT_LIMIT = 5 * 1024 * 1024

function tooLarge(c: Context) {
  return c.json({ error: 'too-large', message: 'The request body is too large.' }, 413)
}

/** 413 `too-large` for a body over 1 MiB, or 5 MiB for the board import. */
export function limitBodies(): MiddlewareHandler {
  const normal = bodyLimit({ maxSize: DEFAULT_LIMIT, onError: tooLarge })
  const large = bodyLimit({ maxSize: IMPORT_LIMIT, onError: tooLarge })
  return (c, next) => (c.req.path === '/api/boards/import' ? large(c, next) : normal(c, next))
}

/** The parsed JSON body; 400 `invalid-request` when it is missing or not valid JSON. */
export async function readJson(c: Context): Promise<unknown> {
  let text: string
  try {
    text = await c.req.text()
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw invalidRequest('The request body could not be read.')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw invalidRequest('The request body must be JSON.')
  }
}

/** Like `readJson`, but an empty body is `{}`. */
export async function readOptionalJson(c: Context): Promise<unknown> {
  const text = (await c.req.text()).trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw invalidRequest('The request body must be JSON.')
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
