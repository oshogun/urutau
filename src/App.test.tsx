import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import v1Export from './board/fixtures/v1-board-export.json'
import { createDefaultBoard } from './domain/board'
import type { StoredBoard } from './domain/api'
import type { BoardConfig } from './domain/types'
import { bindQueryClient } from './hooks/useBoardList'
import { useSession } from './state/session'
import { installApiStub } from './test/apiStub'
import type { ApiStub, ApiStubOptions } from './test/apiStub'

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

let stub: ApiStub

function stubBoard(fullName: string, version: number): StoredBoard {
  return {
    repoKey: fullName.toLowerCase(),
    fullName,
    version,
    updatedAt: '2026-10-01T12:00:00.000Z',
    updatedBy: { id: 'user-1', username: 'ada' },
    board: createDefaultBoard([
      { name: 'bug', color: 'd73a4a', description: null },
      { name: 'in progress', color: '0e8a16', description: null },
    ]),
  }
}
let unbind: (() => void) | null = null

function renderApp(search = '', options: ApiStubOptions = {}) {
  window.history.replaceState(null, '', `/${search}`)
  stub = installApiStub(options)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  unbind = bindQueryClient(queryClient)
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

afterEach(() => {
  unbind?.()
  stub?.restore()
})

beforeEach(() => {
  useSession.setState({ status: 'loading', firstRun: false, session: null, config: null, loadError: null })
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
    expect(await screen.findByRole('heading', { name: /kanban board/i })).toBeInTheDocument()

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

  it('creates the board on the server the first time a repository opens', async () => {
    renderApp('?repo=acme/widgets')
    await screen.findByText('Crash on save')

    await waitFor(() => expect(stub.requests('PUT boards/acme/widgets')).toHaveLength(1))
    const [save] = stub.requests('PUT boards/acme/widgets')
    expect(save.body).toMatchObject({ baseVersion: null, fullName: 'acme/widgets' })
    expect(stub.board('acme/widgets')?.version).toBe(1)
  })

  it('moves an issue with the card menu and saves it with the stored version', async () => {
    const user = userEvent.setup()
    renderApp('?repo=acme/widgets', { boards: [stubBoard('acme/widgets', 3)] })
    await screen.findByText('Crash on save')

    await user.click(screen.getByRole('button', { name: 'Actions for issue #1' }))
    // Carbon keeps the floating menu visibility-hidden until it can measure its
    // position, which never happens in jsdom (no layout); find the item by text.
    await user.click(await screen.findByText('Move to To do'))

    await waitFor(() => expect(within(bucket('To do')).getByText('Crash on save')).toBeInTheDocument())
    await waitFor(() => expect(stub.requests('PUT boards/acme/widgets')).toHaveLength(1))
    const [save] = stub.requests('PUT boards/acme/widgets')
    expect(save.body).toMatchObject({ baseVersion: 3 })
    expect(stub.board('acme/widgets')?.board.placements).toEqual({ 1: 'todo' })
    expect(stub.board('acme/widgets')?.version).toBe(4)
  })

  it('shows the server version and a notice when a save was rejected as stale', async () => {
    const user = userEvent.setup()
    renderApp('?repo=acme/widgets', { boards: [stubBoard('acme/widgets', 1)] })
    await screen.findByText('Crash on save')

    const theirs: BoardConfig = { ...stubBoard('acme/widgets', 1).board, placements: { 1: 'in-review' } }
    // Stored without an event, so this tab does not know yet and its save is refused.
    stub.putBoard('acme/widgets', theirs, { id: 'user-grace', username: 'grace' })

    await user.click(screen.getByRole('button', { name: 'Actions for issue #1' }))
    await user.click(await screen.findByText('Move to To do'))

    expect(await screen.findByText("Your last change wasn't saved.")).toBeInTheDocument()
    expect(screen.getByText('grace changed this board. It now shows their version.')).toBeInTheDocument()
    await waitFor(() => expect(within(bucket('In review')).getByText('Crash on save')).toBeInTheDocument())
    expect(within(bucket('To do')).queryByText('Crash on save')).not.toBeInTheDocument()
  })

  it('offers Retry when a save fails and keeps the edit on screen', async () => {
    const user = userEvent.setup()
    renderApp('?repo=acme/widgets', { boards: [stubBoard('acme/widgets', 1)] })
    await screen.findByText('Crash on save')

    stub.failNext('PUT boards/acme/widgets', { status: 503, error: 'unavailable', message: 'Database down.' })
    await user.click(screen.getByRole('button', { name: 'Actions for issue #1' }))
    await user.click(await screen.findByText('Move to To do'))

    expect(await screen.findByText('Database down.')).toBeInTheDocument()
    expect(within(bucket('To do')).getByText('Crash on save')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(stub.board('acme/widgets')?.board.placements).toEqual({ 1: 'todo' }))
    expect(screen.queryByText('Database down.')).not.toBeInTheDocument()
  })

  it('moves a card and shows a toast when a teammate changes the board', async () => {
    renderApp('?repo=acme/widgets', { boards: [stubBoard('acme/widgets', 1)] })
    await screen.findByText('Crash on save')
    expect(await screen.findByText('Live')).toBeInTheDocument()
    expect(within(bucket('Backlog')).getByText('Crash on save')).toBeInTheDocument()

    const theirs: BoardConfig = { ...stubBoard('acme/widgets', 1).board, placements: { 1: 'in-review' } }
    stub.externalSave('acme/widgets', theirs, { id: 'user-grace', username: 'grace' })

    expect(await screen.findByText('Board updated by grace')).toBeInTheDocument()
    await waitFor(() => expect(within(bucket('In review')).getByText('Crash on save')).toBeInTheDocument())
  })

  it('shows Offline when the stream ends with an HTTP error', async () => {
    renderApp('?repo=acme/widgets', { boards: [stubBoard('acme/widgets', 1)] })
    await screen.findByText('Live')

    stub.failStreams('closed')

    expect(await screen.findByText('Offline')).toBeInTheDocument()
  })

  it('lets the user start a new board after a teammate deleted it', async () => {
    const user = userEvent.setup()
    renderApp('?repo=acme/widgets', { boards: [stubBoard('acme/widgets', 1)] })
    await screen.findByText('Crash on save')

    stub.externalDelete('acme/widgets')

    expect(await screen.findByText('Someone else deleted this board.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Start a new board' }))

    expect(await screen.findByText('Crash on save')).toBeInTheDocument()
    expect(stub.board('acme/widgets')?.version).toBe(1)
    expect(stub.requests('PUT boards/acme/widgets').at(-1)?.body).toMatchObject({ baseVersion: null })
  })

  it('lists the boards on the server on the start page and opens one', async () => {
    const user = userEvent.setup()
    renderApp('', {
      boards: [stubBoard('acme/widgets', 2), stubBoard('acme/gadgets', 1)],
    })

    const list = await screen.findByRole('list', { name: 'Boards on this server' })
    expect(within(list).getByText('acme/widgets')).toBeInTheDocument()
    expect(within(list).getByText('acme/gadgets')).toBeInTheDocument()
    expect(within(list).getAllByText(/Updated by ada on/)).toHaveLength(2)

    await user.click(within(list).getByText('acme/widgets'))
    expect(await screen.findByText('Crash on save')).toBeInTheDocument()
  })

  it('says so when the server has no boards yet', async () => {
    renderApp('')
    expect(await screen.findByText(/No boards on this server yet/)).toBeInTheDocument()
  })

  it('deletes a board from the start page after confirmation', async () => {
    const user = userEvent.setup()
    renderApp('', { boards: [stubBoard('acme/widgets', 2)] })

    await user.click(await screen.findByRole('button', { name: 'Delete the board for acme/widgets' }))
    await user.click(await screen.findByRole('button', { name: 'Delete board' }))

    await waitFor(() => expect(stub.board('acme/widgets')).toBeUndefined())
    expect(stub.requests('DELETE boards/acme/widgets?version=2')).toHaveLength(1)
    expect(stub.requests('DELETE boards/acme/widgets')[0].headers['x-urutau-client']).toBeTruthy()
    expect(await screen.findByText(/No boards on this server yet/)).toBeInTheDocument()
  })

  it('imports a board file exported before the server existed (v1 export fixture)', async () => {
    const user = userEvent.setup()
    renderApp('?repo=acme/widgets', { boards: [stubBoard('acme/widgets', 1)] })
    await screen.findByText('Crash on save')

    await user.click(screen.getByRole('button', { name: 'Board settings' }))
    const file = new File([JSON.stringify(v1Export)], 'urutau-acme-widgets.json', { type: 'application/json' })
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    await user.upload(input, file)

    await waitFor(() => expect(within(bucket('Underway')).getByText('Dark mode')).toBeInTheDocument())
    expect(within(bucket('Shipped')).getByText('Old bug')).toBeInTheDocument()
    await waitFor(() =>
      expect(stub.board('acme/widgets')?.board.buckets.map((b) => b.title)).toEqual([
        'Ideas',
        'Underway',
        'Shipped',
      ]),
    )
    expect(stub.board('acme/widgets')?.board.placements).toEqual({ 1: 'doing' })
  })

  describe('boards kept in this browser by version 1', () => {
    const seed = () =>
      localStorage.setItem(
        'urutau:boards',
        JSON.stringify({
          state: { boards: { 'acme/widgets': v1Export.board, 'acme/gadgets': v1Export.board } },
          version: 1,
        }),
      )

    it('imports them from the prompt and offers a download for a skipped board', async () => {
      const user = userEvent.setup()
      seed()
      renderApp('', { boards: [stubBoard('acme/gadgets', 1)] })

      expect(await screen.findByRole('button', { name: 'Not now' })).toBeInTheDocument()
      await user.click(await screen.findByRole('button', { name: 'Import' }))

      expect(await screen.findByText('Imported 1 board from this browser.')).toBeInTheDocument()
      expect(screen.getByText('acme/gadgets is already on the server, so it was not replaced.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Download my copy' })).toBeInTheDocument()
      expect(stub.board('acme/widgets')?.board.buckets[0].title).toBe('Ideas')
      expect(localStorage.getItem('urutau:boards')).not.toBeNull()
      expect(JSON.parse(localStorage.getItem('urutau:boards-import') ?? '{}').outcome).toBe('imported')
    })

    it('stops asking after Don\'t ask again', async () => {
      const user = userEvent.setup()
      seed()
      renderApp('')

      await user.click(await screen.findByRole('button', { name: "Don't ask again" }))

      expect(screen.queryByRole('button', { name: 'Import' })).not.toBeInTheDocument()
      expect(JSON.parse(localStorage.getItem('urutau:boards-import') ?? '{}').outcome).toBe('declined')
      expect(stub.requests('POST boards/import')).toHaveLength(0)
    })

    it('starts a repository nobody opened yet from this browser\'s board', async () => {
      seed()
      renderApp('?repo=acme/widgets')

      await screen.findByText('Dark mode')
      expect(within(bucket('Underway')).getByText('Dark mode')).toBeInTheDocument()
      const [save] = stub.requests('PUT boards/acme/widgets')
      expect(save.body).toMatchObject({ baseVersion: null })
    })
  })

  it('explains a missing repository and offers settings', async () => {
    renderApp('?repo=acme/missing')
    expect(await screen.findByText(/Repository not found/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeInTheDocument()
  })

  describe('signing in', () => {
    it('shows only the sign-in form to a signed-out visitor', async () => {
      renderApp('?repo=acme/widgets', { session: 'signed-out' })

      expect(await screen.findByRole('heading', { name: 'Sign in to Urutau' })).toBeInTheDocument()
      expect(screen.getByLabelText('Username')).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: /kanban board/i })).not.toBeInTheDocument()
      expect(screen.queryByText('Crash on save')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Account menu/ })).not.toBeInTheDocument()
    })

    it('shows the start page after signing in', async () => {
      const user = userEvent.setup()
      renderApp('', { session: 'signed-out' })

      await user.type(await screen.findByLabelText('Username'), 'ada')
      await user.type(screen.getByLabelText('Password'), 'correct horse')
      await user.click(screen.getByRole('button', { name: 'Sign in' }))

      expect(await screen.findByLabelText('GitHub repository')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Account menu for ada' })).toBeInTheDocument()
    })

    it('explains a wrong password and stays on the form', async () => {
      const user = userEvent.setup()
      renderApp('', { session: 'signed-out' })

      await user.type(await screen.findByLabelText('Username'), 'ada')
      await user.type(screen.getByLabelText('Password'), 'wrong')
      await user.click(screen.getByRole('button', { name: 'Sign in' }))

      expect(await screen.findByText('Wrong username or password.')).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Sign in to Urutau' })).toBeInTheDocument()
    })

    it('offers to create the admin account on a fresh server', async () => {
      const user = userEvent.setup()
      renderApp('', { session: 'first-run' })

      expect(await screen.findByRole('heading', { name: 'Create the admin account' })).toBeInTheDocument()
      await user.type(screen.getByLabelText('Username'), 'founder')
      await user.type(screen.getByLabelText('Password'), 'long enough pw')
      await user.click(screen.getByRole('button', { name: 'Create account' }))

      expect(await screen.findByLabelText('GitHub repository')).toBeInTheDocument()
      expect(stub.requests('POST auth/first-run')[0].body).toEqual({
        username: 'founder',
        password: 'long enough pw',
      })
    })

    it('tells the user when the session ended', async () => {
      renderApp('', {})
      await screen.findByLabelText('GitHub repository')

      stub.failNext('GET boards', { status: 401, error: 'signed-out' })
      await useSession.getState().markSignedOut()

      expect(await screen.findByText('Your session ended; your last change was not saved.')).toBeInTheDocument()
    })
  })

  describe('invites', () => {
    const invite = (token: string) => ({
      summary: {
        id: 'invite-x',
        createdAt: '2026-10-01T00:00:00Z',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        createdBy: null,
      },
      token,
    })

    it('lets the invitee choose a username and password', async () => {
      const user = userEvent.setup()
      renderApp('', { session: 'signed-out' })
      stub.invites.push(invite('abc123'))
      window.history.replaceState(null, '', '/#invite=abc123')
      window.dispatchEvent(new HashChangeEvent('hashchange'))

      await user.type(await screen.findByLabelText('Username'), 'grace')
      await user.type(screen.getByLabelText('Password'), 'another long pw')
      await user.click(screen.getByRole('button', { name: 'Create account' }))

      expect(await screen.findByLabelText('GitHub repository')).toBeInTheDocument()
      expect(stub.requests('POST invites/accept')[0].body).toEqual({
        token: 'abc123',
        username: 'grace',
        password: 'another long pw',
      })
      expect(window.location.hash).toBe('')
      expect(stub.requests('POST invites/check')).toHaveLength(1)
    })

    it('treats a malformed invite fragment as an invalid invite', async () => {
      renderApp('#invite=%E0%A4%A', { session: 'signed-out' })

      expect(await screen.findByText('This invite link is not valid any more.')).toBeInTheDocument()
    })

    it('says so when the invite link is not valid', async () => {
      window.history.replaceState(null, '', '/#invite=nope')
      renderApp('#invite=nope', { session: 'signed-out' })

      expect(await screen.findByText('This invite link is not valid any more.')).toBeInTheDocument()
      expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    })

    it('asks a signed-in visitor to sign out first', async () => {
      renderApp('#invite=abc123')

      expect(await screen.findByText('Sign out to accept this invite.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    })
  })

  describe('users screen', () => {
    it('lets the admin create an invite link and remove a user', async () => {
      const user = userEvent.setup()
      renderApp('?view=users', { accounts: [{ username: 'grace', password: 'pw pw pw pw' }] })

      expect(await screen.findByRole('heading', { name: 'Users' })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Create invite link' }))
      expect(await screen.findByText(/#invite=token-/)).toBeInTheDocument()
      expect(stub.requests('POST invites')[0].body).toEqual({ expiresInHours: 168 })

      await user.click(await screen.findByRole('button', { name: 'Remove grace' }))
      await user.click(await screen.findByRole('button', { name: 'Remove user' }))
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove grace' })).not.toBeInTheDocument())
      expect(stub.users.map((u) => u.username)).toEqual(['ada'])
    })

    it('never shows the users screen to a member', async () => {
      renderApp('?view=users', { user: { isAdmin: false } })

      expect(await screen.findByLabelText('GitHub repository')).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Users' })).not.toBeInTheDocument()
      expect(stub.requests('GET users')).toHaveLength(0)
    })
  })
})
