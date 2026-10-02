import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'

const ghIssue = (number: number, title: string, labels: string[], extra: Record<string, unknown> = {}) => ({
  number,
  title,
  state: 'open',
  state_reason: null,
  html_url: `https://github.com/acme/widgets/issues/${number}`,
  labels: labels.map((name) => ({ name })),
  assignees: [],
  user: { login: 'hubot', avatar_url: 'https://avatars/hubot', html_url: 'https://github.com/hubot' },
  milestone: null,
  comments: 0,
  created_at: `2026-09-${String(number).padStart(2, '0')}T00:00:00Z`,
  updated_at: '2026-09-30T00:00:00Z',
  closed_at: null,
  ...extra,
})

const ROUTES: Record<string, unknown> = {
  '/repos/acme/widgets': {
    full_name: 'acme/widgets',
    description: 'Widgets for everyone',
    html_url: 'https://github.com/acme/widgets',
    private: false,
  },
  '/repos/acme/widgets/labels': [
    { name: 'bug', color: 'd73a4a', description: null },
    { name: 'in progress', color: '0e8a16', description: null },
  ],
  'open:/repos/acme/widgets/issues': [
    ghIssue(1, 'Crash on save', ['bug']),
    ghIssue(2, 'Dark mode', ['in progress']),
    ghIssue(3, 'A pull request', [], { pull_request: {} }),
  ],
  'closed:/repos/acme/widgets/issues': [
    ghIssue(4, 'Old bug', ['bug'], { state: 'closed', closed_at: new Date().toISOString() }),
  ],
}

function renderApp(search = '') {
  window.history.replaceState(null, '', `/${search}`)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  )
}

const bucket = (title: string) => {
  const heading = screen.getByRole('heading', { level: 2, name: title })
  return heading.closest('section') as HTMLElement
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input))
      const state = url.searchParams.get('state')
      const body = ROUTES[state ? `${state}:${url.pathname}` : url.pathname]
      return body === undefined
        ? new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 })
    }),
  )
})

describe('App', () => {
  it('asks for a repository and validates the input', async () => {
    const user = userEvent.setup()
    renderApp()
    expect(screen.getByRole('heading', { name: /kanban board/i })).toBeInTheDocument()

    await user.type(screen.getByLabelText('GitHub repository'), 'not a repo')
    await user.click(screen.getByRole('button', { name: 'Open board' }))
    expect(screen.getByText(/Enter a repository as owner\/name/)).toBeInTheDocument()
  })

  it('shows issues in buckets, with labels, routing rules and closed issues', async () => {
    renderApp('?repo=acme/widgets')

    expect(await screen.findByRole('link', { name: /acme\/widgets/ })).toBeInTheDocument()
    // The "in progress" label is picked up as a routing rule for the "In progress" bucket.
    expect(within(bucket('In progress')).getByText('Dark mode')).toBeInTheDocument()
    expect(within(bucket('Backlog')).getByText('Crash on save')).toBeInTheDocument()
    expect(within(bucket('Done')).getByText('Old bug')).toBeInTheDocument()
    expect(screen.queryByText('A pull request')).not.toBeInTheDocument()
    expect(within(bucket('Backlog')).getByText('bug')).toBeInTheDocument()
  })

  it('moves an issue with the card menu and remembers it', async () => {
    const user = userEvent.setup()
    renderApp('?repo=acme/widgets')
    await screen.findByText('Crash on save')

    await user.click(screen.getByRole('button', { name: 'Actions for issue #1' }))
    // Carbon keeps the floating menu visibility-hidden until it can measure its
    // position, which never happens in jsdom (no layout); find the item by text.
    await user.click(await screen.findByText('Move to To do'))

    await waitFor(() => expect(within(bucket('To do')).getByText('Crash on save')).toBeInTheDocument())
    const stored = JSON.parse(localStorage.getItem('urutau:boards') ?? '{}')
    expect(stored.state.boards['acme/widgets'].placements).toEqual({ 1: 'todo' })
  })

  it('explains a missing repository and offers settings', async () => {
    renderApp('?repo=acme/missing')
    expect(await screen.findByText(/Repository not found/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument()
  })
})
