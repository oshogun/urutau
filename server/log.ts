/** Structured logging: one JSON object per line on stdout, with known secrets removed. */
import { SECRET_PATTERNS } from './github/tokenFormats.ts'

export type LogFields = Record<string, string | number | boolean | null>

export interface Logger {
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

const REDACTED = '[redacted]'

/** Removes every literal occurrence of each secret from the text. Empty secrets are ignored. */
export function redact(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join(REDACTED)
  }
  return result
}

/**
 * The strings of a connection URL that must never be printed: the whole URL
 * and its password component, both as written and percent-decoded.
 */
export function urlSecrets(url: string): string[] {
  const secrets = [url]
  try {
    const parsed = new URL(url)
    if (parsed.password) {
      secrets.push(parsed.password)
      try {
        secrets.push(decodeURIComponent(parsed.password))
      } catch {
        // A '%' that is not an escape: the password as written is already listed.
      }
    }
  } catch {
    // Not parseable as a URL: the whole string is still redacted.
  }
  return secrets
}

export interface LoggerOptions {
  write?: (line: string) => void
  now?: () => Date
  secrets?: readonly string[]
  /** Also replace token-shaped values (SECRET_PATTERNS) with [redacted]. Default false. */
  patterns?: boolean
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const write = options.write ?? ((line: string) => process.stdout.write(line + '\n'))
  const now = options.now ?? (() => new Date())
  const secrets = options.secrets ?? []
  const clean = (text: string) => {
    // Token matches and literal-secret matches are both found on the original text and
    // overlapping ones are merged, so each merged span becomes one [redacted]. Replacing
    // one kind first would split a span of the other kind and leave part of it printed.
    // Each pattern is copied so a lastIndex left on the shared global regex is ignored.
    const spans: Array<[number, number]> = []
    if (options.patterns) {
      for (const pattern of SECRET_PATTERNS) {
        for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) spans.push([match.index, match.index + match[0].length])
      }
    }
    for (const secret of secrets) {
      if (!secret) continue
      for (let at = text.indexOf(secret); at !== -1; at = text.indexOf(secret, at + 1)) {
        spans.push([at, at + secret.length])
      }
    }
    if (spans.length === 0) return text
    spans.sort((x, y) => x[0] - y[0] || y[1] - x[1])
    let result = ''
    let last = 0
    let [start, end] = spans[0]
    for (const [from, to] of spans.slice(1)) {
      if (from <= end) {
        end = Math.max(end, to)
        continue
      }
      result += text.slice(last, start) + REDACTED
      last = end
      ;[start, end] = [from, to]
    }
    return result + text.slice(last, start) + REDACTED + text.slice(end)
  }
  const emit = (level: string, msg: string, fields: LogFields = {}) => {
    const cleaned: LogFields = {}
    for (const [key, value] of Object.entries(fields)) {
      cleaned[key] = typeof value === 'string' ? clean(value) : value
    }
    write(JSON.stringify({ time: now().toISOString(), level, msg: clean(msg), ...cleaned }))
  }
  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  }
}
