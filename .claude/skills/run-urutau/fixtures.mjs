// Canned GitHub REST responses for the driver's default "fixtures" mode, so the
// app can be driven without network access, a token, or the anonymous limit of
// 60 API requests an hour. Payloads only carry the fields src/github/api.ts reads.
//
// Repositories:
//   acme/widgets  labeled open issues (two pages), one PR (filtered out by the app),
//                 recently closed issues, and one closed long ago (outside the window)
//   acme/empty    no labels, no issues
//   acme/readonly two open issues; creating or changing an issue answers 403, like a token without write access
//   acme/limited  403 with an exhausted rate limit
//   anything else 404, like a private repository without a token
//
// Creating an issue (POST /repos/{owner}/{repo}/issues) works on acme/widgets and acme/empty with any
// non-empty Authorization header; the new issue is kept in memory until the driver stops.
//
// GET /repos/{owner}/{repo}/issues/{number} answers the issue from the open or closed list (the pull
// request #11 with its pull_request key), or 404. acme/widgets #2 is the stale case: its single-issue
// answer is a newer version than the list holds (another title, one more line in the description,
// updated an hour before the driver started), so the first change to it is refused as stale. After
// the first PATCH to it, the list and the single-issue answer both serve the changed issue.
//
// Changing an issue (PATCH /repos/{owner}/{repo}/issues/{number}) answers, in order: 401 without an
// Authorization header; 403 on acme/readonly; 404 for an unknown number; 422 for a body that is not
// a JSON object, a key other than title, body, state and state_reason, a title that is not
// non-blank text, a state other than open or closed, or a state_reason other than completed,
// not_planned, reopened or null. Otherwise it applies the fields to GitHub's current version of the
// issue and answers 200 with it. A state change moves the issue between the open and closed lists
// (closing sets state_reason, default completed, and closed_at; reopening sets state_reason
// reopened and clears closed_at); the same state leaves state_reason alone. updated_at is the time
// of the change, in whole seconds. Changes are kept in memory until the driver stops. Any other
// PATCH path answers 404.
//
// answerGitHub (Request to Response) and fixtureFetch (fetch-shaped, rejects any URL outside
// https://api.github.com/) answer the same data for a server-side caller such as the MCP launcher;
// routeGitHubFixtures wraps answerGitHub for Playwright. Any method other than GET, HEAD, POST, PATCH
// and OPTIONS on acme/widgets, acme/empty or acme/readonly answers 405; acme/limited answers 403 to
// every method.

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
  const { assignees = [], milestone = null, age = number, body = null, ...rest } = extra
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
    body,
    ...rest,
  }
}

const closed = (number, title, labels, closedDaysAgo, reason = 'completed', extra = {}) =>
  issue(number, title, labels, {
    state: 'closed',
    state_reason: reason,
    closed_at: daysAgo(closedDaysAgo),
    age: closedDaysAgo + 20,
    ...extra,
  })

// Issue bodies. #3 has none (GitHub sends null) and #6 has an empty string; the other open issues of
// acme/widgets and the closed ones not named here have a null body.
/** #1 "Crash when saving an empty widget": Markdown, raw HTML, refused links, images. */
const BODY_1 = `<!-- Thanks for reporting a bug. Describe what happened below. -->

## What happened

Saving a widget with an empty name crashes the editor. The console shows:

\`\`\`text
TypeError: Cannot read properties of undefined (reading 'trim')
    at saveWidget (editor.js:42:17)
\`\`\`

## Steps to reproduce

1. Open **Widgets** and press *New widget*.
2. Leave the name empty.
3. Press \`Save\`.

## Checklist

- [x] I searched the existing issues
- [ ] I tried the latest release

| Browser | Version | Crashes |
| :------ | ------: | :-----: |
| Firefox | 131 | yes |
| Safari | 18.1 | no |

<details><summary>Screenshot</summary>

<img width="640" alt="Editor after the crash" src="https://github.com/user-attachments/assets/00000000-0000-4000-8000-000000000001" />

</details>

![Diagram of the save flow](https://example.com/save-flow.png)

Related: https://github.com/acme/widgets/issues/4 and the [design notes](../wiki/Saving).

These must never become active: [run this](javascript:alert(1)), [open this](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==), <a href="javascript:alert(2)">raw link</a>, <img src=x onerror=alert(3)>.

<script>alert(4)</script>

> Reported from the **Firefox** extension.
`

/** #2 "Add dark mode to the settings page": a short, ordinary body. */
const BODY_2 = `The settings page ignores the theme switch and stays light.

- Follow the theme chosen in Settings
- Keep the contrast of labels readable

See [Carbon themes](https://carbondesignsystem.com/elements/themes/overview/).`

/** #3 "Document the REST endpoints": GitHub's null body. */
const BODY_3 = null

/** #6 "Typo in the onboarding email": an empty string. */
const BODY_6 = ''

/** #4 "Widget list is slow with 10k items": longer than BODY_RENDER_LIMIT (131,072), so it is cut and the notice shows. */
const BODY_4 =
  '## Profile\n\n' +
  Array.from({ length: 3000 }, (_, i) => `${i + 1}. Rendering widget ${i + 1} took ${(i % 97) + 3} ms in the list view.`).join('\n')

/** #10 "Rate limit the public API": long (23,629 characters) but under the limit, so it scrolls and is not cut. */
const BODY_10 = Array.from(
  { length: 60 },
  (_, i) =>
    `### Limit ${i + 1}\n\nRequests from one address are counted per hour. When the count passes the limit, the API answers 429 with a Retry-After header, and the widget list shows the time the limit resets. Counting starts again on the hour; requests with a token use the token's own count instead of the address. This paragraph repeats so that the description is long enough to scroll inside the dialog.`,
).join('\n\n')

/**
 * #14 "Explain how widget quotas work": a table of 121 columns whose rows give only 2 cells. GitHub
 * pads every row to 121 cells; the table-cell estimate is 121 x 91 = 11,011,
 * more than TABLE_CELLS_MAX (10,000), so the body is parsed with tables turned off: the table shows
 * as its Markdown text and the "Tables in this description are shown as plain text." notice appears.
 */
const BODY_14 =
  'How are quotas counted? The export below lists the quota of every plan for every widget type.\n\n' +
  '| Plan |' + Array.from({ length: 120 }, (_, i) => ` Type ${i + 1} |`).join('') + '\n' +
  '|' + ' --- |'.repeat(121) + '\n' +
  Array.from({ length: 90 }, (_, i) => `| Plan ${i + 1} | 10 |`).join('\n')

/**
 * #8 "Dropdown closes when scrolling on Safari": a short paragraph, then one paragraph of 131,000
 * code units made of 'a<!--' repeated. markdown-it 15.0.2's inline HTML rule scans to the end of the
 * paragraph from every '<!--' that has no '-->', so parsing it takes about 6 s in headless Chromium,
 * six times the body worker's 1,000 ms limit. The modal shows the loading placeholder, then
 * the body as plain text with the "This description is shown as plain text." notice. Its length,
 * 131,050, is under BODY_RENDER_LIMIT, so it is not cut.
 */
const BODY_8 =
  'The dropdown closes as soon as the list scrolls.\n\n' + 'a<!--'.repeat(26_200)

/**
 * #12 "Add keyboard shortcuts for common actions": one paragraph of 55,500 code units (55,570 in all) that
 * alternates Latin and Hebrew text. Laid out as one block it would take hundreds of milliseconds in
 * Chromium; the converter splits it into runs of at most RUN_TEXT_MAX (2,048) code units, each its
 * own block box.
 */
const BODY_12 =
  'Proposed shortcuts, with the labels the Hebrew interface would show:\n\n' +
  'Ctrl+K \u05e4\u05ea\u05d7 \u05d7\u05d9\u05e4\u05d5\u05e9, Ctrl+B \u05d4\u05d5\u05e1\u05e3 \u05db\u05e8\u05d8\u05d9\u05e1, '.repeat(1_500)

/** #15 (closed, completed). */
const BODY_15 = 'Widgets created offline were not saved. Fixed by saving the queue before the page unloads.'

/** #17 (closed, not planned). */
const BODY_17 = 'Internet Explorer 11 is out of support, so this will not be done.'

const OPEN = [
  issue(1, 'Crash when saving an empty widget', ['bug', 'priority: high'], {
    assignees: ['octocat'],
    milestone: 'v1.0',
    comments: 4,
    age: 40,
    body: BODY_1,
  }),
  issue(2, 'Add dark mode to the settings page', ['enhancement', 'area: ui', 'status: in progress'], {
    assignees: ['monalisa'],
    milestone: 'v1.0',
    comments: 2,
    age: 35,
    body: BODY_2,
  }),
  issue(3, 'Document the REST endpoints', ['documentation', 'good first issue'], { age: 33, body: BODY_3 }),
  issue(4, 'Widget list is slow with 10k items', ['bug', 'area: api', 'needs review'], {
    assignees: ['hubot'],
    comments: 7,
    age: 30,
    body: BODY_4,
  }),
  issue(5, 'Support CSV export', ['enhancement', 'help wanted'], { milestone: 'v1.1', age: 28 }),
  issue(6, 'Typo in the onboarding email', ['documentation'], { comments: 1, age: 25, body: BODY_6 }),
  issue(7, 'Use a stable sort for widget names', ['enhancement', 'area: api', 'status: in progress'], {
    assignees: ['octocat', 'hubot'],
    age: 22,
  }),
  issue(8, 'Dropdown closes when scrolling on Safari', ['bug', 'area: ui', 'question'], { age: 20, body: BODY_8 }),
  // Page break: the first page ends here and links to page 2.
  issue(9, "Rename 'gizmo' to 'widget' everywhere", ['good first issue'], { age: 18 }),
  issue(10, 'Rate limit the public API', ['enhancement', 'area: api'], {
    milestone: 'v1.1',
    comments: 3,
    age: 15,
    body: BODY_10,
  }),
  issue(11, 'Bump vite from 8.2.0 to 8.3.2', [], { pull_request: { url: 'https://api.github.com/x' }, age: 2 }),
  issue(12, 'Add keyboard shortcuts for common actions', ['enhancement', 'area: ui', 'help wanted'], {
    age: 12,
    body: BODY_12,
  }),
  issue(13, 'Login redirects to a 404 after a password reset', ['bug', 'needs review'], {
    assignees: ['monalisa'],
    comments: 5,
    age: 9,
  }),
  issue(14, 'Explain how widget quotas work', ['question'], { age: 6, body: BODY_14 }),
]

const CLOSED = [
  closed(15, 'Widgets vanish after a refresh', ['bug'], 1, 'completed', { body: BODY_15 }),
  closed(16, 'Add a favicon', ['enhancement', 'good first issue'], 3),
  closed(17, 'Support Internet Explorer 11', ['wontfix'], 5, 'not_planned', { body: BODY_17 }),
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

REPOS['acme/readonly'] = {
  repo: {
    full_name: 'acme/readonly',
    description: 'Public repository the fixture token cannot write to',
    html_url: 'https://github.com/acme/readonly',
    private: false,
  },
  labels: LABELS,
  open: [
    { ...issue(1, 'Clarify the install steps', ['documentation'], { age: 10 }), html_url: 'https://github.com/acme/readonly/issues/1' },
    { ...issue(2, 'Add a changelog', ['enhancement'], { age: 8 }), html_url: 'https://github.com/acme/readonly/issues/2' },
  ],
  closed: [],
}

const STARTED_AT = Date.now()

/**
 * Versions GitHub holds that are newer than the list's: the single-issue answer and the base of
 * the next PATCH use them, until a PATCH replaces the issue in the list.
 */
const NEWER = new Map([
  [
    'acme/widgets#2',
    {
      ...OPEN.find((item) => item.number === 2),
      title: 'Add dark mode to the settings page and the editor',
      body: `${BODY_2}\n- Also follow the theme in the widget editor`,
      updated_at: new Date(STARTED_AT - 60 * 60 * 1000).toISOString(),
    },
  ],
])

const wholeSeconds = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

/** The issue with `number` as GitHub holds it now, and the list it sits in. */
function findIssue(key, fixture, number) {
  const newer = NEWER.get(`${key}#${number}`)
  const inOpen = fixture.open.find((item) => item.number === number)
  const inClosed = fixture.closed.find((item) => item.number === number)
  const listed = inOpen ?? inClosed
  return listed ? { issue: newer ?? listed, listed, list: inOpen ? fixture.open : fixture.closed } : null
}

const invalid = (field, code) =>
  json(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code, field }] })

/** Answers PATCH .../issues/{number} the way GitHub does for the cases the app handles. */
async function updateIssue(request, key, fixture, number) {
  const authorization = request.headers.get('authorization') ?? ''
  if (authorization.replace(/^Bearer\s*/i, '').trim() === '') {
    return json(401, { message: 'Requires authentication' })
  }
  if (key === 'acme/readonly') {
    return json(403, {
      message: 'Resource not accessible by personal access token',
      documentation_url: 'https://docs.github.com/rest/issues/issues#update-an-issue',
      status: '403',
    })
  }
  const found = findIssue(key, fixture, number)
  if (!found) return json(404, { message: 'Not Found' })
  let fields
  try {
    fields = JSON.parse((await request.text()) || '')
  } catch {
    fields = null
  }
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) return invalid('body', 'invalid')
  const unknownKey = Object.keys(fields).find((field) => !['title', 'body', 'state', 'state_reason'].includes(field))
  if (unknownKey !== undefined) return invalid(unknownKey, 'invalid')
  if ('title' in fields && (typeof fields.title !== 'string' || fields.title.trim() === '')) {
    return invalid('title', 'missing_field')
  }
  if ('body' in fields && fields.body !== null && typeof fields.body !== 'string') return invalid('body', 'invalid')
  if ('state' in fields && fields.state !== 'open' && fields.state !== 'closed') return invalid('state', 'invalid')
  if ('state_reason' in fields && ![null, 'completed', 'not_planned', 'reopened'].includes(fields.state_reason)) {
    return invalid('state_reason', 'invalid')
  }

  const updated = { ...found.issue, updated_at: wholeSeconds() }
  if ('title' in fields) updated.title = fields.title
  if ('body' in fields) updated.body = fields.body
  if ('state' in fields && fields.state !== updated.state) {
    if (fields.state === 'closed') {
      updated.state = 'closed'
      updated.state_reason = fields.state_reason ?? 'completed'
      updated.closed_at = new Date().toISOString()
    } else {
      updated.state = 'open'
      updated.state_reason = 'reopened'
      updated.closed_at = null
    }
  }
  NEWER.delete(`${key}#${number}`)
  found.list.splice(found.list.indexOf(found.listed), 1)
  const target = updated.state === 'open' ? fixture.open : fixture.closed
  if (updated.state === 'open') {
    const after = target.findIndex((item) => item.number > number)
    target.splice(after === -1 ? target.length : after, 0, updated)
  } else {
    target.push(updated)
  }
  return json(200, updated)
}

/** Answers POST .../issues the way GitHub does for the cases the app handles. */
async function createIssue(request, key, fixture) {
  const authorization = request.headers.get('authorization') ?? ''
  if (authorization.replace(/^Bearer\s*/i, '').trim() === '') {
    return json(401, { message: 'Requires authentication' })
  }
  if (key === 'acme/readonly') {
    return json(403, {
      message: 'Resource not accessible by personal access token',
      documentation_url: 'https://docs.github.com/rest/issues/issues#create-an-issue',
      status: '403',
    })
  }
  let fields
  try {
    fields = JSON.parse((await request.text()) || '')
  } catch {
    fields = null
  }
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    return json(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'invalid', field: 'body' }] })
  }
  const unknownKey = Object.keys(fields).find((field) => field !== 'title' && field !== 'body')
  if (unknownKey !== undefined) {
    return json(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'invalid', field: unknownKey }] })
  }
  if (typeof fields.title !== 'string' || fields.title.trim() === '') {
    return json(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'missing_field', field: 'title' }] })
  }
  const served = Math.max(0, ...fixture.open.map((item) => item.number), ...fixture.closed.map((item) => item.number))
  const number = served + 1
  const created = {
    ...issue(number, fields.title, [], { user: user('fixture-user'), age: 0 }),
    html_url: `https://github.com/${fixture.repo.full_name}/issues/${number}`,
    updated_at: new Date().toISOString(),
    body: typeof fields.body === 'string' ? fields.body : null,
  }
  fixture.open.push(created)
  return json(201, created)
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'link, x-ratelimit-remaining, x-ratelimit-reset',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      ...headers,
    },
  })
}

/** The fake GitHub token the driver stores on an integration. */
export const FIXTURE_GITHUB_TOKEN = 'github_pat_urutau_fixture_not_a_real_token'

/** Answers one GitHub API request from the canned data; never touches the network. */
export async function answerGitHub(request) {
  // The app sends custom headers, so the browser may preflight cross-origin requests.
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
        'access-control-allow-headers': request.headers.get('access-control-request-headers') ?? '*',
      },
    })
  }
  const url = new URL(request.url)
  const parts = url.pathname.split('/')
  const [, repos, owner, name, resource, number] = parts
  const singleIssuePath = parts.length === 6
  const key = `${owner}/${name}`.toLowerCase()
  if (repos !== 'repos') return json(404, { message: 'Not Found' })

  if (key === 'acme/limited') {
    const reset = Math.floor(Date.now() / 1000) + 45 * 60
    return json(403, { message: 'API rate limit exceeded' }, {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(reset),
    })
  }

  const fixture = REPOS[key]
  if (!fixture) return json(404, { message: 'Not Found' })
  if (request.method === 'POST') {
    return resource === 'issues' ? createIssue(request, key, fixture) : json(404, { message: 'Not Found' })
  }
  if (request.method === 'PATCH') {
    return singleIssuePath && resource === 'issues' && /^[1-9][0-9]*$/.test(number ?? '')
      ? updateIssue(request, key, fixture, Number(number))
      : json(404, { message: 'Not Found' })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json(405, { message: 'Method Not Allowed' }, { allow: 'GET, POST, PATCH, OPTIONS' })
  }
  if (!resource) return json(200, fixture.repo)
  if (resource === 'labels') return json(200, fixture.labels)
  if (resource !== 'issues') return json(404, { message: 'Not Found' })
  if (number !== undefined) {
    if (!singleIssuePath) return json(404, { message: 'Not Found' })
    const found = /^[1-9][0-9]*$/.test(number) ? findIssue(key, fixture, Number(number)) : null
    return found ? json(200, found.issue) : json(404, { message: 'Not Found' })
  }

  if (url.searchParams.get('state') === 'closed') return json(200, fixture.closed)

  // Serve open issues over two pages to exercise the app's Link-header pagination.
  const page = Number(url.searchParams.get('page') ?? '1')
  const items = fixture.open.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const hasNext = page * PAGE_SIZE < fixture.open.length
  const next = new URL(url)
  next.searchParams.set('page', String(page + 1))
  return json(200, items, hasNext ? { link: `<${next}>; rel="next"` } : {})
}

/** A fetch-shaped function: https://api.github.com/ requests get the canned answers, any other URL rejects. */
export async function fixtureFetch(input, init) {
  const request = new Request(input, init)
  if (!request.url.startsWith('https://api.github.com/')) {
    throw new TypeError('fixture fetch answers only https://api.github.com')
  }
  return answerGitHub(request)
}

async function handleApi(route) {
  const source = route.request()
  const body = source.postData()
  const request = new Request(source.url(), {
    method: source.method(),
    headers: source.headers(),
    body: body !== null && source.method() !== 'GET' && source.method() !== 'HEAD' ? body : undefined,
  })
  const response = await answerGitHub(request)
  return route.fulfill({
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: await response.text(),
  })
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
