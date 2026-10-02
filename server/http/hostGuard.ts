import type { MiddlewareHandler } from 'hono'
import type { AppContext } from '../app.ts'
import type { Config } from '../config.ts'
import type { AppEnv } from './types.ts'

const MAX_REMEMBERED = 100
const MAX_LOGGED_HOST = 255

/** The lower-case hostname of a `host[:port]` authority with one trailing dot removed, or null when it does not parse. */
function hostnameOf(authority: string): string | null {
  try {
    return new URL(`http://${authority}`).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

function isLiteralAddress(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[')
}

/** Names the server answers for besides localhost and IP addresses: the PUBLIC_URL hostname and ALLOWED_HOSTS. */
export function acceptedHostnames(config: Pick<Config, 'publicUrl' | 'allowedHosts'>): string[] {
  const names = [...config.allowedHosts]
  if (config.publicUrl !== null) {
    const fromUrl = hostnameOf(new URL(config.publicUrl).host)
    if (fromUrl !== null) names.unshift(fromUrl)
  }
  return [...new Set(names)]
}

function isLoopbackBind(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/** The warning to print at start when the server listens beyond loopback and no PUBLIC_URL or ALLOWED_HOSTS says which names are its own. */
export function startupWarning(config: Pick<Config, 'host' | 'port' | 'publicUrl' | 'allowedHosts'>): string | null {
  if (isLoopbackBind(config.host) || config.publicUrl !== null || config.allowedHosts.length > 0) return null
  return `Listening on ${config.host}:${config.port} without PUBLIC_URL or ALLOWED_HOSTS: only requests addressed to localhost or an IP address are answered. Set PUBLIC_URL to the address people open.`
}

/**
 * Answers 403 `host-not-allowed` unless the request is addressed to localhost,
 * an IP address, the PUBLIC_URL hostname or an ALLOWED_HOSTS entry. A DNS
 * rebinding page reaches this server under a name the attacker controls, and
 * such a name is never one of those. Both the request URL's host and the Host
 * header are checked; X-Forwarded-Host is never read.
 */
export function hostGuard(ctx: AppContext): MiddlewareHandler<AppEnv> {
  const accepted = new Set(acceptedHostnames(ctx.config))
  const reported = new Set<string>()

  const allowed = (hostname: string | null): boolean =>
    hostname !== null && hostname !== '' && (hostname === 'localhost' || isLiteralAddress(hostname) || accepted.has(hostname))

  return async (c, next) => {
    const header = c.req.header('host')
    const urlHost = hostnameOf(new URL(c.req.url).host)
    if (allowed(urlHost) && (header === undefined || allowed(hostnameOf(header)))) return next()

    // Report the authority that failed: the request target's when that is the refused one, else the Host header's.
    const urlAuthority = new URL(c.req.url).host
    const seen = (allowed(urlHost) ? (header ?? urlAuthority) : urlAuthority).slice(0, MAX_LOGGED_HOST)
    const name = hostnameOf(seen) ?? seen
    if (!reported.has(name) && reported.size < MAX_REMEMBERED) {
      reported.add(name)
      ctx.log.warn('request refused: host not allowed', { host: seen })
    }
    const message = 'This server does not answer for this address. Its administrator can add it with PUBLIC_URL or ALLOWED_HOSTS.'
    if (c.req.path === '/api' || c.req.path.startsWith('/api/')) {
      return c.json({ error: 'host-not-allowed', message }, 403)
    }
    return c.text(message, 403)
  }
}
