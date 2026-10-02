/** Routes that answer without a session. Every other /api route answers 401 `signed-out`. */
const PUBLIC_ROUTES: readonly string[] = [
  'GET /api/health',
  'GET /api/config',
  'GET /api/session',
  'POST /api/auth/first-run',
  'POST /api/auth/sign-in',
  'POST /api/auth/sign-out',
  'POST /api/invites/check',
  'POST /api/invites/accept',
  'GET /api/auth/keycloak/start',
  'GET /api/auth/keycloak/callback',
]

export function isPublicRoute(method: string, path: string): boolean {
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase()
  return PUBLIC_ROUTES.includes(`${verb} ${normalized}`)
}

export { PUBLIC_ROUTES }
