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
import { useSettings } from './state/settings'
import { installApiStub, stubCreatedIssue } from './test/apiStub'
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

  // This is the first test to open a card menu, so Carbon's menu and floating-position code is
  // loaded and compiled here: about 1 s alone, 1.8 s with three test runs in parallel and over 5 s
  // with a dozen. The default 5 s limit then fails a test that has nothing wrong with it.
  it('moves an issue with the card menu and saves it with the stored version', { timeout: 15_000 }, async () => {
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

  describe('Keycloak', () => {
    const startLink = (name: string) => screen.queryByRole('link', { name })

    it('hides the Keycloak button when the server has Keycloak off', async () => {
      renderApp('', { session: 'signed-out', keycloak: false })
      await screen.findByRole('heading', { name: 'Sign in to Urutau' })
      expect(startLink('Sign in with Keycloak')).not.toBeInTheDocument()
    })

    it('offers Sign in with Keycloak when the server has it on', async () => {
      renderApp('', { session: 'signed-out', keycloak: true })
      await screen.findByRole('heading', { name: 'Sign in to Urutau' })
      expect(startLink('Sign in with Keycloak')).toHaveAttribute('href', 'api/auth/keycloak/start')
    })

    it('offers Sign in with Keycloak on the first-run screen only when Keycloak is on', async () => {
      renderApp('', { session: 'first-run', keycloak: true })
      await screen.findByRole('heading', { name: 'Create the admin account' })
      expect(startLink('Sign in with Keycloak')).toHaveAttribute('href', 'api/auth/keycloak/start')
      expect(screen.getByText(/first person to sign in, by either method, becomes the administrator/)).toBeInTheDocument()
    })

    it('hides the Keycloak button on the first-run screen when Keycloak is off', async () => {
      renderApp('', { session: 'first-run', keycloak: false })
      await screen.findByRole('heading', { name: 'Create the admin account' })
      expect(startLink('Sign in with Keycloak')).not.toBeInTheDocument()
      expect(screen.queryByText(/first person to sign in/)).not.toBeInTheDocument()
    })

    it.each([
      ['keycloak-unavailable', 'Keycloak could not be reached. Try again in a moment.'],
      ['keycloak-expired', 'The Keycloak sign-in took too long. Start it again.'],
      ['keycloak-denied', 'Keycloak did not let you in.'],
      ['keycloak-failed', 'The Keycloak sign-in failed. Start it again.'],
      ['something-else', 'Signing in failed. Try again.'],
    ])('explains ?signin-error=%s', async (code, message) => {
      renderApp(`?signin-error=${code}`, { session: 'signed-out', keycloak: true })
      expect(await screen.findByText(message)).toBeInTheDocument()
      expect(window.location.search).toBe('')
    })

    it('hides the token field in server mode and explains why', async () => {
      const user = userEvent.setup()
      renderApp('', { githubAccess: { mode: 'server' } })
      expect(await screen.findByText('GitHub is read through your Keycloak link.')).toBeInTheDocument()
      expect(screen.queryByLabelText(/Personal access token/)).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Settings' }))
      expect(await screen.findAllByText('GitHub is read through your Keycloak link.')).toHaveLength(2)
      expect(screen.queryByLabelText('GitHub personal access token')).not.toBeInTheDocument()
    })

    it('shows the token field to a Keycloak user without a GitHub link', async () => {
      const user = userEvent.setup()
      renderApp('', { githubAccess: { mode: 'browser', problem: 'not-linked' } })
      expect(await screen.findByLabelText(/Personal access token/)).toBeInTheDocument()
      expect(screen.getByText('Your Keycloak account has no linked GitHub account.')).toBeInTheDocument()
      expect(startLink('Sign in with Keycloak again')).not.toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Settings' }))
      expect(await screen.findByLabelText('GitHub personal access token')).toBeInTheDocument()
    })

    it('offers to sign in again when the Keycloak link expired', async () => {
      renderApp('', { githubAccess: { mode: 'browser', problem: 'signin-expired' } })
      await screen.findByLabelText(/Personal access token/)
      expect(startLink('Sign in with Keycloak again')).toHaveAttribute('href', 'api/auth/keycloak/start')
    })

    it('shows the problem and a sign-in-again action when the board cannot be read', async () => {
      renderApp('?repo=acme/widgets', {
        githubAccess: { mode: 'server' },
        github: () =>
          new Response(JSON.stringify({ error: 'github-access', message: 'x', problem: 'signin-expired' }), {
            status: 424,
            headers: { 'Content-Type': 'application/json' },
          }),
      })
      expect(await screen.findByText(/Couldn't load acme\/widgets/)).toBeInTheDocument()
      expect(
        screen.getByText('Sign in with Keycloak again to read issues through your GitHub link.'),
      ).toBeInTheDocument()
      expect(startLink('Sign in with Keycloak again')).toHaveAttribute('href', 'api/auth/keycloak/start')
    })
  })

  describe('GitHub errors in server mode', () => {
    it('offers Keycloak sign-in, not Settings, after a GitHub 401 on the server path', async () => {
      renderApp('?repo=acme/widgets', {
        githubAccess: { mode: 'server' },
        github: () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }),
      })
      expect(await screen.findByText(/Couldn't load acme\/widgets/)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Sign in with Keycloak again' })).toHaveAttribute(
        'href',
        'api/auth/keycloak/start',
      )
      expect(screen.queryByRole('button', { name: 'Open settings' })).not.toBeInTheDocument()
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
  describe('creating issues', () => {
    type PostHandler = (init: RequestInit) => Response | Promise<Response>
    let posts: RequestInit[]

    // Wraps the test's GitHub stub so a POST to the issues endpoint reaches `handler`. A held
    // answer is dropped with an AbortError when the request's signal aborts, as a real fetch does.
    function stubGitHubPost(handler: PostHandler) {
      const read = globalThis.fetch
      posts = []
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (input, init) => {
          if (init?.method !== 'POST' || !String(input).endsWith('/repos/acme/widgets/issues')) {
            return read(input, init)
          }
          posts.push(init)
          const answer = Promise.resolve(handler(init))
          return new Promise<Response>((resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
            answer.then(resolve, reject)
          })
        }),
      )
    }

    const created = (number: number, title: string) =>
      new Response(JSON.stringify(stubCreatedIssue('acme/widgets', number, title)), { status: 201 })
    const snapshotGets = () =>
      vi.mocked(fetch).mock.calls.filter(([input, init]) => !init?.method && String(input).includes('api.github.com'))

    async function openDialog(user: ReturnType<typeof userEvent.setup>, bucketTitle = 'In progress') {
      await screen.findByText('Dark mode')
      await user.click(screen.getByRole('button', { name: `Create issue in ${bucketTitle}` }))
      return screen.findByRole('dialog', { name: /^acme\/widgets · / })
    }

    const open = (options: ApiStubOptions = {}) =>
      renderApp('?repo=acme/widgets', { githubWrites: true, boards: [stubBoard('acme/widgets', 1)], ...options })

    beforeEach(() => {
      useSettings.setState({ token: 'fixture-token' })
      stubGitHubPost(() => created(11, 'unused'))
    })
    afterEach(() => useSettings.setState({ token: '' }))

    it('offers no create action while the switch is off', async () => {
      open({ githubWrites: false })
      await screen.findByText('Dark mode')
      expect(screen.queryByRole('button', { name: /Create issue in/ })).not.toBeInTheDocument()
    })

    it('offers the action in every bucket except the one that collects closed issues', async () => {
      open()
      await screen.findByText('Dark mode')
      expect(await screen.findByRole('button', { name: 'Create issue in Backlog' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Create issue in In progress' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Create issue in Done' })).not.toBeInTheDocument()
    })

    it('puts the new card in the bucket it was created from, with no further snapshot request', async () => {
      const user = userEvent.setup()
      stubGitHubPost(() => created(11, 'Fix the build'))
      open()
      await screen.findByText('Dark mode')
      await screen.findByRole('button', { name: 'Create issue in In progress' })
      const before = snapshotGets().length

      await openDialog(user)
      await user.type(screen.getByLabelText('Title'), 'Fix the build')
      await user.click(screen.getByRole('button', { name: 'Create issue' }))

      expect(await screen.findByText('Created issue #11')).toBeInTheDocument()
      expect(within(bucket('In progress')).getByText('Fix the build')).toBeInTheDocument()
      expect(JSON.parse(String(posts[0].body))).toEqual({ title: 'Fix the build' })
      expect(snapshotGets()).toHaveLength(before)
      await waitFor(() => expect(stub.board('acme/widgets')?.board.placements).toMatchObject({ 11: 'in-progress' }))
      expect(screen.queryByRole('dialog', { name: /^acme\/widgets · / })).not.toBeInTheDocument()
    })

    it('keeps the typed text and shows the mapped message when GitHub refuses', async () => {
      const user = userEvent.setup()
      stubGitHubPost(
        () => new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403 }),
      )
      open()
      await openDialog(user)
      await user.type(screen.getByLabelText('Title'), 'Fix the build')
      await user.type(screen.getByLabelText('Description (optional)'), 'Steps to reproduce')
      await user.click(screen.getByRole('button', { name: 'Create issue' }))

      expect(await screen.findByText("Couldn't create the issue.")).toBeInTheDocument()
      expect(screen.getByText(/Your token can't create issues in acme\/widgets/)).toBeInTheDocument()
      expect(screen.getByLabelText('Title')).toHaveValue('Fix the build')
      expect(screen.getByLabelText('Description (optional)')).toHaveValue('Steps to reproduce')
      expect(screen.getByRole('button', { name: 'Create issue' })).toBeEnabled()
    })

    it('disables the button while sending and ignores a second Enter', async () => {
      const user = userEvent.setup()
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => (release = resolve))
      stubGitHubPost(async () => {
        await gate
        return created(11, 'Fix the build')
      })
      open()
      await openDialog(user)
      await user.type(screen.getByLabelText('Title'), 'Fix the build{Enter}')

      const sending = await screen.findByRole('button', { name: /Creating issue/ })
      expect(sending).toBeDisabled()
      await user.type(screen.getByLabelText('Title'), '{Enter}')
      expect(posts).toHaveLength(1)

      release()
      expect(await screen.findByText('Created issue #11')).toBeInTheDocument()
      expect(posts).toHaveLength(1)
    })

    it('stops waiting on Esc while sending, then closes on the next Esc', async () => {
      const user = userEvent.setup()
      stubGitHubPost(() => new Promise<Response>(() => undefined))
      open()
      await openDialog(user)
      await user.type(screen.getByLabelText('Title'), 'Fix the build{Enter}')
      await screen.findByRole('button', { name: /Creating issue/ })

      await user.keyboard('{Escape}')
      expect(await screen.findByText('The issue may have been created.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Refresh board' })).toBeInTheDocument()
      expect(screen.getByLabelText('Title')).toHaveValue('Fix the build')
      expect(posts).toHaveLength(1)

      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /^acme\/widgets · / })).not.toBeInTheDocument())
    })

    it('keeps focus inside the dialog, closes on Esc and returns focus to the bucket button', async () => {
      const user = userEvent.setup()
      open()
      const dialog = await openDialog(user, 'Backlog')
      await waitFor(() => expect(screen.getByLabelText('Title')).toHaveFocus())

      for (let press = 0; press < 8; press += 1) {
        await user.tab()
        expect(dialog).toContainElement(document.activeElement as HTMLElement)
      }

      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /^acme\/widgets · / })).not.toBeInTheDocument())
      expect(screen.getByRole('button', { name: 'Create issue in Backlog' })).toHaveFocus()
    })

    it('refuses a title over 256 characters before sending', async () => {
      const user = userEvent.setup()
      open()
      await openDialog(user)
      await user.click(screen.getByLabelText('Title'))
      await user.paste('x'.repeat(257))

      expect(screen.getByText('Use at most 256 characters.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Create issue' })).toBeDisabled()
      expect(posts).toHaveLength(0)
    })

    it('says a token is needed when none is saved, and disables Create', async () => {
      const user = userEvent.setup()
      useSettings.setState({ token: '' })
      open()
      await openDialog(user)

      expect(screen.getByText('A token with write access is needed.')).toBeInTheDocument()
      await user.type(screen.getByLabelText('Title'), 'Fix the build')
      expect(screen.getByRole('button', { name: 'Create issue' })).toBeDisabled()
    })
  })

  describe('server settings', () => {
    it('shows the switch to the admin and saves a change', async () => {
      const user = userEvent.setup()
      renderApp('?view=server-settings')

      expect(await screen.findByRole('heading', { name: 'Server settings' })).toBeInTheDocument()
      const toggle = await screen.findByRole('switch', { name: 'Create issues on GitHub' })
      expect(toggle).not.toBeChecked()
      await user.click(toggle)

      await waitFor(() => expect(screen.getByRole('switch', { name: 'Create issues on GitHub' })).toBeChecked())
      expect(stub.requests('PATCH settings')[0].body).toEqual({ githubWrites: true })
      expect(stub.githubWrites).toBe(true)
    })

    it('reaches the page from the account menu for an admin only', async () => {
      const user = userEvent.setup()
      renderApp('')
      await screen.findByLabelText('GitHub repository')
      await user.click(screen.getByRole('button', { name: 'Account menu for ada' }))
      await user.click(await screen.findByText('Server settings'))
      expect(await screen.findByRole('heading', { name: 'Server settings' })).toBeInTheDocument()
    })

    it('hides the item and the page from a member', async () => {
      const user = userEvent.setup()
      renderApp('?view=server-settings', { user: { isAdmin: false } })

      expect(await screen.findByLabelText('GitHub repository')).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: 'Server settings' })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /Account menu for/ }))
      expect(await screen.findByText(/Signed in as/)).toBeInTheDocument()
      expect(screen.queryByText('Server settings')).not.toBeInTheDocument()
    })
  })
})
