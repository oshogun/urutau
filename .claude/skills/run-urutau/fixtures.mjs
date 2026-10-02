// Canned GitHub REST responses for the driver's default "fixtures" mode, so the
// app can be driven without network access, a token, or the anonymous limit of
// 60 API requests an hour. Payloads only carry the fields src/github/api.ts reads.
//
// Repositories:
//   acme/widgets  labeled open issues (two pages), one PR (filtered out by the app),
//                 recently closed issues, and one closed long ago (outside the window)
//   acme/empty    no labels, no issues
//   acme/limited  403 with an exhausted rate limit
//   anything else 404, like a private repository without a token

const DAY = 86_400_000
const AVATAR_HOST = 'https://fixtures.urutau.test'

const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString()

const user = (login) => ({
  login,
  avatar_url: `${AVATAR_HOST}/avatars/${login}.svg`,
  html_url: `https://github.com/${login}`,
})

const LABELS = [
  ['bug', 'd73a4a', "Something isn't working"],
  ['documentation', '0075ca', 'Improvements or additions to documentation'],
  ['enhancement', 'a2eeef', 'New feature or request'],
  ['good first issue', '7057ff', 'Good for newcomers'],
  ['help wanted', '008672', 'Extra attention is needed'],
  ['question', 'd876e3', 'Further information is requested'],
  ['wontfix', 'ffffff', 'This will not be worked on'],
  ['status: in progress', '0e8a16', null],
  ['needs review', 'fbca04', null],
  ['area: api', '1d76db', null],
  ['area: ui', 'c5def5', null],
  ['priority: high', 'b60205', null],
].map(([name, color, description]) => ({ name, color, description }))

function issue(number, title, labels, extra = {}) {
  const { assignees = [], milestone = null, age = number, ...rest } = extra
  return {
    number,
    title,
    state: 'open',
    state_reason: null,
    html_url: `https://github.com/acme/widgets/issues/${number}`,
    labels: labels.map((name) => LABELS.find((label) => label.name === name) ?? { name }),
    assignees: assignees.map(user),
    user: user('hubot'),
    milestone: milestone ? { title: milestone } : null,
    comments: 0,
    created_at: daysAgo(age),
    updated_at: daysAgo(1),
    closed_at: null,
    ...rest,
  }
}

const closed = (number, title, labels, closedDaysAgo, reason = 'completed') =>
  issue(number, title, labels, {
    state: 'closed',
    state_reason: reason,
    closed_at: daysAgo(closedDaysAgo),
    age: closedDaysAgo + 20,
  })

const OPEN = [
  issue(1, 'Crash when saving an empty widget', ['bug', 'priority: high'], {
    assignees: ['octocat'],
    milestone: 'v1.0',
    comments: 4,
    age: 40,
  }),
  issue(2, 'Add dark mode to the settings page', ['enhancement', 'area: ui', 'status: in progress'], {
    assignees: ['monalisa'],
    milestone: 'v1.0',
    comments: 2,
    age: 35,
  }),
  issue(3, 'Document the REST endpoints', ['documentation', 'good first issue'], { age: 33 }),
  issue(4, 'Widget list is slow with 10k items', ['bug', 'area: api', 'needs review'], {
    assignees: ['hubot'],
    comments: 7,
    age: 30,
  }),
  issue(5, 'Support CSV export', ['enhancement', 'help wanted'], { milestone: 'v1.1', age: 28 }),
  issue(6, 'Typo in the onboarding email', ['documentation'], { comments: 1, age: 25 }),
  issue(7, 'Use a stable sort for widget names', ['enhancement', 'area: api', 'status: in progress'], {
    assignees: ['octocat', 'hubot'],
    age: 22,
  }),
  issue(8, 'Dropdown closes when scrolling on Safari', ['bug', 'area: ui', 'question'], { age: 20 }),
  // Page break: the first page ends here and links to page 2.
  issue(9, "Rename 'gizmo' to 'widget' everywhere", ['good first issue'], { age: 18 }),
  issue(10, 'Rate limit the public API', ['enhancement', 'area: api'], {
    milestone: 'v1.1',
    comments: 3,
    age: 15,
  }),
  issue(11, 'Bump vite from 8.2.0 to 8.3.2', [], { pull_request: { url: 'https://api.github.com/x' }, age: 2 }),
  issue(12, 'Add keyboard shortcuts for common actions', ['enhancement', 'area: ui', 'help wanted'], {
    age: 12,
  }),
  issue(13, 'Login redirects to a 404 after a password reset', ['bug', 'needs review'], {
    assignees: ['monalisa'],
    comments: 5,
    age: 9,
  }),
  issue(14, 'Explain how widget quotas work', ['question'], { age: 6 }),
]

const CLOSED = [
  closed(15, 'Widgets vanish after a refresh', ['bug'], 1),
  closed(16, 'Add a favicon', ['enhancement', 'good first issue'], 3),
  closed(17, 'Support Internet Explorer 11', ['wontfix'], 5, 'not_planned'),
  // Updated recently (so GitHub's `since` returns it) but closed long ago: the app drops it.
  { ...closed(18, 'Closed long ago', ['bug'], 200), updated_at: daysAgo(1) },
]

const REPOS = {
  'acme/widgets': {
    repo: {
      full_name: 'acme/widgets',
      description: 'Widgets for everyone (fixture data served by the run-urutau driver)',
      html_url: 'https://github.com/acme/widgets',
      private: false,
    },
    labels: LABELS,
    open: OPEN,
    closed: CLOSED,
  },
  'acme/empty': {
    repo: { full_name: 'acme/empty', description: null, html_url: 'https://github.com/acme/empty', private: true },
    labels: [],
    open: [],
    closed: [],
  },
}

const PAGE_SIZE = 8

function json(route, status, body, headers = {}) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'link, x-ratelimit-remaining, x-ratelimit-reset',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

function handleApi(route) {
  const request = route.request()
  // The app sends custom headers, so the browser may preflight cross-origin requests.
  if (request.method() === 'OPTIONS') {
    return route.fulfill({
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '*',
      },
    })
  }
  const url = new URL(request.url())
  const [, repos, owner, name, resource] = url.pathname.split('/')
  const key = `${owner}/${name}`.toLowerCase()
  if (repos !== 'repos') return json(route, 404, { message: 'Not Found' })

  if (key === 'acme/limited') {
    const reset = Math.floor(Date.now() / 1000) + 45 * 60
    return json(route, 403, { message: 'API rate limit exceeded' }, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(reset),
    })
  }

  const fixture = REPOS[key]
  if (!fixture) return json(route, 404, { message: 'Not Found' })
  if (!resource) return json(route, 200, fixture.repo)
  if (resource === 'labels') return json(route, 200, fixture.labels)
  if (resource !== 'issues') return json(route, 404, { message: 'Not Found' })

  if (url.searchParams.get('state') === 'closed') return json(route, 200, fixture.closed)

  // Serve open issues over two pages to exercise the app's Link-header pagination.
  const page = Number(url.searchParams.get('page') ?? '1')
  const items = fixture.open.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const hasNext = page * PAGE_SIZE < fixture.open.length
  const next = new URL(url)
  next.searchParams.set('page', String(page + 1))
  return json(route, 200, items, hasNext ? { link: `<${next}>; rel="next"` } : {})
}

function avatar(route) {
  const login = new URL(route.request().url()).pathname.split('/').pop()?.replace(/\.svg$/, '') ?? '?'
  const hue = [...login].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 360
  return route.fulfill({
    status: 200,
    contentType: 'image/svg+xml',
    body: `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="hsl(${hue} 55% 45%)"/><text x="20" y="27" font-family="sans-serif" font-size="20" fill="#fff" text-anchor="middle">${login[0]?.toUpperCase() ?? '?'}</text></svg>`,
  })
}

/** Routes every GitHub API (and fixture avatar) request in `context` to the canned data above. */
export async function routeGitHubFixtures(context) {
  await context.route('https://api.github.com/**', handleApi)
  await context.route(`${AVATAR_HOST}/**`, avatar)
}
