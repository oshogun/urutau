import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Issue } from '../domain/types'
import { parseIssueBody } from '../markdown/issueBody'
import { parseBodyInWorker } from '../markdown/parseBodyInWorker'
import { UpdateIssueError, updateIssueFailures } from '../github/updateIssue'
import type { IssueUpdater, UpdateIssueInput } from '../hooks/useUpdateIssue'
import { useSettings } from '../state/settings'
import { makeIssue, makeLabel } from '../test/fixtures'
import { IssueCard } from './IssueCard'
import { IssueDetailModal } from './IssueDetailModal'

vi.mock('../markdown/parseBodyInWorker', () => ({ parseBodyInWorker: vi.fn() }))

const mocked = vi.mocked(parseBodyInWorker)

beforeEach(() => {
  mocked.mockImplementation(async (body, issueUrl) => ({
    status: 'parsed',
    parsed: parseIssueBody(body, issueUrl),
  }))
})
afterEach(() => mocked.mockReset())

const user = (login: string) => ({ login, avatarUrl: `https://avatars/${login}`, url: `https://github.com/${login}` })

function renderModal(issue: Issue, onClose = vi.fn()) {
  render(
    <IssueDetailModal
      issue={issue}
      repoFullName="acme/widgets"
      labelsByName={new Map([['bug', makeLabel('bug', 'd73a4a')]])}
      fetchedAt={Date.UTC(2026, 9, 1, 12, 30)}
      launcherButtonRef={createRef<HTMLButtonElement>()}
      onClose={onClose}
    />,
  )
  return onClose
}

describe('IssueDetailModal', () => {
  it('shows the facts, the fields and the formatted body', async () => {
    renderModal(
      makeIssue(12, {
        title: 'Crash on save',
        body: 'Steps:\n\n- one',
        labels: ['bug'],
        author: user('hubot'),
        assignees: [user('octo'), user('mona'), user('a'), user('b'), user('c')],
        milestone: 'v1',
        comments: 1,
        updatedAt: '2026-09-30T00:00:00Z',
      }),
    )
    const dialog = screen.getByRole('dialog', { name: 'acme/widgets #12' })
    expect(within(dialog).getByRole('heading', { name: 'Crash on save' })).toBeInTheDocument()
    expect(within(dialog).getByText('Open')).toBeInTheDocument()
    expect(within(dialog).getByText('hubot')).toBeInTheDocument()
    expect(within(dialog).getByText('1 comment')).toBeInTheDocument()
    expect(within(dialog).getByText('bug')).toBeInTheDocument()
    for (const login of ['octo', 'mona', 'a', 'b', 'c']) {
      expect(within(dialog).getByText(login)).toBeInTheDocument()
    }
    expect(within(dialog).getByText('v1')).toBeInTheDocument()
    expect(within(dialog).getByText(/^Loaded with the board at /)).toBeInTheDocument()
    expect(await within(dialog).findByText('one')).toBeInTheDocument()
    const link = within(dialog).getByRole('link', { name: 'Open on GitHub' })
    expect(link).toHaveAttribute('href', 'https://github.com/acme/widgets/issues/12')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noreferrer')
    expect(dialog.querySelector('img')).not.toBeNull()
    expect(screen.queryByRole('list', { name: /comments/i })).not.toBeInTheDocument()
  })

  it('leaves out what the issue does not have', () => {
    const { container } = render(
      <IssueDetailModal
        issue={makeIssue(3, { body: '' })}
        repoFullName="acme/widgets"
        labelsByName={new Map()}
        fetchedAt={0}
        launcherButtonRef={createRef<HTMLButtonElement>()}
        onClose={() => {}}
      />,
    )
    expect(container.ownerDocument.querySelector('dl')).toBeNull()
    expect(screen.getByText('No comments')).toBeInTheDocument()
    expect(screen.getByText('No description provided.')).toBeInTheDocument()
    expect(screen.queryByText(/ by /)).not.toBeInTheDocument()
    expect(screen.queryByText(/^Closed /)).not.toBeInTheDocument()
    expect(mocked).not.toHaveBeenCalled()
  })

  it('shows when and why a closed issue was closed', () => {
    renderModal(makeIssue(5, { state: 'closed', stateReason: 'not_planned', closedAt: '2026-09-20T00:00:00Z' }))
    expect(screen.getByText('Closed as not planned').closest('.cds--tag')).toHaveClass('cds--tag--gray')
    expect(screen.getByText(/^Closed$/, { selector: 'span' })).toBeInTheDocument()
  })

  it('scrolls its content inside the modal', () => {
    renderModal(makeIssue(1, { body: 'x' }))
    const region = screen.getByRole('region', { name: 'acme/widgets #1' })
    expect(region).toHaveClass('cds--modal-scroll-content')
    expect(region).toHaveAttribute('tabindex', '0')
    expect(region).toContainElement(screen.getByText(/^Loaded with the board at /))
  })

  it('closes on Escape and on the close button', async () => {
    const events = userEvent.setup()
    const onClose = renderModal(makeIssue(1))
    await waitFor(() => expect(screen.getByRole('region')).toHaveFocus())
    await events.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    await events.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

const TOKEN = 'github_pat_urutau_fixture_not_a_real_token'

/** Keeps the issue in state the way the board's cache does: the modal shows what `onUpdate` returns. */
function Harness({
  initial,
  update,
  onClose = () => {},
  onOpenSettings,
  onRefresh,
}: {
  initial: Issue
  update: (input: UpdateIssueInput, current: Issue) => Promise<Issue>
  onClose?: () => void
  onOpenSettings?: () => void
  onRefresh?: () => void
}) {
  const [issue, setIssue] = useState(initial)
  const onUpdate: IssueUpdater = async (input) => {
    try {
      const next = await update(input, issue)
      setIssue(next)
      return next
    } catch (error) {
      if (error instanceof UpdateIssueError && error.current) setIssue(error.current)
      throw error
    }
  }
  return (
    <IssueDetailModal
      issue={issue}
      repoFullName="acme/widgets"
      labelsByName={new Map()}
      fetchedAt={0}
      launcherButtonRef={createRef<HTMLButtonElement>()}
      onClose={onClose}
      onUpdate={onUpdate}
      onOpenSettings={onOpenSettings}
      onRefresh={onRefresh}
    />
  )
}

/** React's generated ids differ between renders; the markup is otherwise compared as it is. */
const withoutIds = (html: string) => html.replace(/_r_[0-9a-z]+_/g, '_r_')

const staleError = (current: Issue) =>
  new UpdateIssueError({ kind: 'stale', status: 409, current, message: 'The issue changed on GitHub.' })

describe('IssueDetailModal changes', () => {
  // jsdom has no layout, so Carbon's focus wrap moves focus to the dialog after the footer
  // goes away; the ids focused in order show where the modal sent focus.
  let focused: string[] = []
  const recordFocus = (event: FocusEvent) => focused.push((event.target as HTMLElement).id)
  beforeEach(() => {
    useSettings.setState({ token: TOKEN })
    focused = []
    document.addEventListener('focusin', recordFocus)
  })
  afterEach(() => {
    useSettings.setState({ token: '' })
    document.removeEventListener('focusin', recordFocus)
  })

  const base = makeIssue(1, { title: 'Crash', body: 'Old body', updatedAt: '2026-01-01T00:00:00Z' })
  const saved = (issue: Issue, patch: Partial<Issue>): Issue => ({ ...issue, ...patch, updatedAt: '2026-02-01T00:00:00Z' })

  function renderModal(update: (input: UpdateIssueInput, current: Issue) => Promise<Issue>, initial = base, extra = {}) {
    render(<Harness initial={initial} update={update} {...extra} />)
    return userEvent.setup()
  }

  it('renders the same markup without onUpdate and with null, and no change controls', () => {
    const props = {
      issue: base,
      repoFullName: 'acme/widgets',
      labelsByName: new Map<string, never>(),
      fetchedAt: 0,
      launcherButtonRef: createRef<HTMLButtonElement>(),
      onClose: () => {},
    }
    const first = render(<IssueDetailModal {...props} />)
    const without = first.container.innerHTML
    first.unmount()
    const second = render(<IssueDetailModal {...props} onUpdate={null} />)
    expect(withoutIds(second.container.innerHTML)).toBe(withoutIds(without))
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Close as|Reopen/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('shows Edit and both close buttons on an open issue, Edit and Reopen on a closed one', () => {
    renderModal(vi.fn())
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Close as completed' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Close as not planned' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument()
  })

  it('shows Edit and Reopen on a closed issue', () => {
    renderModal(vi.fn(), makeIssue(2, { state: 'closed', stateReason: 'completed' }))
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Close as/ })).not.toBeInTheDocument()
  })

  it('saves only the changed fields against the issue updatedAt, then returns to Edit', async () => {
    const update = vi.fn(async (_input: UpdateIssueInput, current: Issue) => saved(current, { title: 'Crash on save' }))
    const user = renderModal(update)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const title = screen.getByRole('textbox', { name: 'Title' })
    await waitFor(() => expect(focused).toContain('issue-edit-title'))
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Old body')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    await user.clear(title)
    await user.type(title, 'Crash on save')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(update.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        fullName: 'acme/widgets',
        number: 1,
        expectedUpdatedAt: '2026-01-01T00:00:00Z',
        fields: { title: 'Crash on save' },
      }),
    )
    expect(await screen.findByText('Title changed.')).toBeInTheDocument()
    await waitFor(() => expect(focused).toContain('issue-edit-button'))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  describe('Enter in the edit title', () => {
    const imeKeys = [
      ['isComposing', { key: 'Enter', isComposing: true }],
      ['keyCode 229', { key: 'Enter', keyCode: 229 }],
    ] as const

    it.each(imeKeys)('does not save on an IME Enter (%s)', async (_name, init) => {
      const update = vi.fn(async (_input: UpdateIssueInput, current: Issue) => saved(current, { title: 'Crash!' }))
      const user = renderModal(update)
      await user.click(screen.getByRole('button', { name: 'Edit' }))
      await user.type(screen.getByRole('textbox', { name: 'Title' }), '!')
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Title' }), init)
      expect(update).not.toHaveBeenCalled()
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Crash!')
    })

    it('saves on a plain Enter', async () => {
      const update = vi.fn(async (_input: UpdateIssueInput, current: Issue) => saved(current, { title: 'Crash!' }))
      const user = renderModal(update)
      await user.click(screen.getByRole('button', { name: 'Edit' }))
      await user.type(screen.getByRole('textbox', { name: 'Title' }), '!{Enter}')
      await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    })
  })

  it('says both fields changed after saving the title and the description', async () => {
    const update = vi.fn(async (_input: UpdateIssueInput, current: Issue) => saved(current, { title: 'Crash!', body: 'New' }))
    const user = renderModal(update)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), '!')
    const body = screen.getByRole('textbox', { name: 'Description' })
    await user.clear(body)
    await user.type(body, 'New')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Title and description changed.')).toBeInTheDocument()
  })

  it('keeps focus in the dialog when changes are turned off while a button has focus', async () => {
    const props = {
      issue: base,
      repoFullName: 'acme/widgets',
      labelsByName: new Map<string, never>(),
      fetchedAt: 0,
      launcherButtonRef: createRef<HTMLButtonElement>(),
      onClose: () => {},
    }
    const onUpdate: IssueUpdater = async (_input) => base
    const view = render(<IssueDetailModal {...props} onUpdate={onUpdate} />)
    const button = screen.getByRole('button', { name: 'Close as completed' })
    button.focus()
    expect(button).toHaveFocus()
    // A browser leaves focus on the body when the focused button is removed, while Carbon's focus
    // wrap in jsdom moves it into the dialog at once; the body is reported to match the browser.
    // jsdom cannot focus the content area, so the move is observed as a call to focus().
    const activeSpy = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(document.body)
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus')
    view.rerender(<IssueDetailModal {...props} onUpdate={null} />)
    expect(screen.queryByRole('button', { name: 'Close as completed' })).not.toBeInTheDocument()
    try {
      await waitFor(() =>
        expect(focusSpy.mock.contexts.some((el) => (el as HTMLElement).classList.contains('cds--modal-content'))).toBe(true),
      )
    } finally {
      focusSpy.mockRestore()
      activeSpy.mockRestore()
    }
  })

  it('does not send a CRLF description that was left alone', async () => {
    const update = vi.fn(async (_input: UpdateIssueInput, current: Issue) => current)
    const user = renderModal(update, makeIssue(1, { title: 'Crash', body: 'a\r\nb' }))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), '!')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(update.mock.calls[0]![0].fields).toEqual({ title: 'Crash!' })
  })

  it('flags a blank title and a title over 256 characters and disables Save', async () => {
    const user = renderModal(vi.fn())
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const title = screen.getByRole('textbox', { name: 'Title' })
    await user.clear(title)
    expect(screen.getByText('A title is required.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    await user.click(title)
    await user.paste('x'.repeat(257))
    expect(screen.getByText('Use at most 256 characters.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })

  it.each([
    ['Close as completed', { state: 'closed', state_reason: 'completed' }, 'Closed as completed.', 'Reopen'],
    ['Close as not planned', { state: 'closed', state_reason: 'not_planned' }, 'Closed as not planned.', 'Reopen'],
  ])('%s sends the state and focuses Reopen', async (name, fields, text, next) => {
    const update = vi.fn(async (input: UpdateIssueInput, current: Issue) =>
      saved(current, { state: 'closed', stateReason: input.fields.state_reason ?? null }),
    )
    const user = renderModal(update)
    await user.click(screen.getByRole('button', { name }))
    expect(update.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ expectedUpdatedAt: '2026-01-01T00:00:00Z', fields }),
    )
    expect(await screen.findByText(text)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: next })).toHaveFocus())
  })

  it('reopens and focuses Close as completed', async () => {
    const update = vi.fn(async (_input: UpdateIssueInput, current: Issue) =>
      saved(current, { state: 'open', stateReason: 'reopened' }),
    )
    const user = renderModal(update, makeIssue(2, { state: 'closed', stateReason: 'completed', body: 'x' }))
    await user.click(screen.getByRole('button', { name: 'Reopen' }))
    expect(update.mock.calls[0]![0].fields).toEqual({ state: 'open', state_reason: 'reopened' })
    expect(await screen.findByText('Reopened.')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close as completed' })).toHaveFocus())
  })

  it('refuses a stale edit with what changed, keeps the text, and Apply again uses the new updatedAt', async () => {
    const current = makeIssue(1, {
      title: 'Crash (renamed)',
      body: 'New body',
      updatedAt: '2026-01-05T00:00:00Z',
    })
    const update = vi
      .fn<(input: UpdateIssueInput, current: Issue) => Promise<Issue>>()
      .mockRejectedValueOnce(staleError(current))
      .mockImplementationOnce(async (_input, now) => saved(now, { body: 'My body' }))
    const user = renderModal(update)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const body = screen.getByRole('textbox', { name: 'Description' })
    await user.clear(body)
    await user.type(body, 'My body')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(
      await screen.findByText('This issue changed on GitHub since you started editing. Nothing was sent.'),
    ).toBeInTheDocument()
    expect(screen.getByText('The title is now “Crash (renamed)”.')).toBeInTheDocument()
    expect(screen.getByText('The description changed.')).toBeInTheDocument()
    expect(screen.getByText(/You and GitHub both changed the description/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Description on GitHub now' })).toHaveValue('New body')
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('My body')
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Crash (renamed)')
    await user.click(screen.getByRole('button', { name: 'Apply again' }))
    expect(update.mock.calls[1]![0]).toEqual(
      expect.objectContaining({ expectedUpdatedAt: '2026-01-05T00:00:00Z', fields: { body: 'My body' } }),
    )
    expect(await screen.findByText('Description changed.')).toBeInTheDocument()
  })

  it('says it is already closed when a state change is refused as stale and the issue moved', async () => {
    const current = makeIssue(1, { state: 'closed', stateReason: 'duplicate', updatedAt: '2026-01-05T00:00:00Z' })
    const update = vi.fn().mockRejectedValueOnce(staleError(current))
    const user = renderModal(update)
    await user.click(screen.getByRole('button', { name: 'Close as completed' }))
    expect(await screen.findByText('It is already closed as duplicate on GitHub.')).toBeInTheDocument()
    expect(screen.getByText('It is now closed as duplicate.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply again' })).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument())
  })

  describe('when the issue prop stays older than what the dialog has seen', () => {
    const modalWith = (issue: Issue, update: IssueUpdater) => (
      <IssueDetailModal
        issue={issue}
        repoFullName="acme/widgets"
        labelsByName={new Map()}
        fetchedAt={0}
        launcherButtonRef={createRef<HTMLButtonElement>()}
        onClose={() => {}}
        onUpdate={update}
      />
    )

    it('starts Edit and Close from the newest version after two refusals', async () => {
      const v2 = makeIssue(1, { title: 'Two', body: 'Two body', updatedAt: '2026-01-03T00:00:00Z' })
      const v3 = makeIssue(1, { title: 'Three', body: 'Three body', updatedAt: '2026-01-05T00:00:00Z' })
      const update = vi
        .fn<IssueUpdater>()
        .mockRejectedValueOnce(staleError(v2))
        .mockRejectedValueOnce(staleError(v3))
        .mockRejectedValueOnce(staleError(v3))
      render(modalWith(base, update))
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Close as completed' }))
      expect(await screen.findByText('The title is now “Two”.')).toBeInTheDocument()
      expect(screen.getByRole('heading', { name: 'Two' })).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Edit' }))
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Two')
      await user.type(screen.getByRole('textbox', { name: 'Title' }), '!')
      await user.click(screen.getByRole('button', { name: 'Save changes' }))
      expect(update.mock.calls[1]![0].expectedUpdatedAt).toBe('2026-01-03T00:00:00Z')
      await screen.findByRole('button', { name: 'Apply again' })

      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await user.click(screen.getByRole('button', { name: 'Edit' }))
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Three')
      expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('Three body')

      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      await user.click(screen.getByRole('button', { name: 'Close as completed' }))
      expect(update.mock.calls[2]![0].expectedUpdatedAt).toBe('2026-01-05T00:00:00Z')
    })

    it('shows Closed and Reopen after a refusal whose current issue is closed', async () => {
      const closed = makeIssue(1, {
        state: 'closed',
        stateReason: 'completed',
        closedAt: '2026-01-05T00:00:00Z',
        updatedAt: '2026-01-05T00:00:00Z',
      })
      const update = vi.fn<IssueUpdater>().mockRejectedValueOnce(staleError(closed))
      const view = render(modalWith(base, update))
      const user = userEvent.setup()
      expect(screen.getByText('Open', { selector: '.cds--tag *' })).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Close as completed' }))
      await screen.findByText('It is already closed as completed on GitHub.')
      view.rerender(modalWith(base, update))
      expect(screen.getByText('Closed as completed', { selector: '.cds--tag *' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Reopen' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Close as completed' })).not.toBeInTheDocument()
    })

    it('keeps the closed version a successful change returned when the prop is the old open copy', async () => {
      const closed = makeIssue(1, {
        state: 'closed',
        stateReason: 'completed',
        closedAt: '2026-02-01T00:00:00Z',
        updatedAt: '2026-02-01T00:00:00Z',
      })
      const update = vi.fn<IssueUpdater>().mockResolvedValueOnce(closed).mockRejectedValueOnce(staleError(closed))
      const view = render(modalWith(base, update))
      const user = userEvent.setup()
      await user.click(screen.getByRole('button', { name: 'Close as completed' }))
      await screen.findByText('Closed as completed.')
      view.rerender(modalWith(base, update))
      await user.click(await screen.findByRole('button', { name: 'Reopen' }))
      expect(update.mock.calls[1]![0].expectedUpdatedAt).toBe('2026-02-01T00:00:00Z')
      expect(screen.getByText('Closed as completed', { selector: '.cds--tag *' })).toBeInTheDocument()
    })
  })

  it('offers Apply again for a refused state change that still applies', async () => {
    const current = makeIssue(1, { body: 'Edited elsewhere', updatedAt: '2026-01-05T00:00:00Z' })
    const update = vi
      .fn<(input: UpdateIssueInput, current: Issue) => Promise<Issue>>()
      .mockRejectedValueOnce(staleError(current))
      .mockImplementationOnce(async (_input, now) => saved(now, { state: 'closed', stateReason: 'completed' }))
    const user = renderModal(update)
    await user.click(screen.getByRole('button', { name: 'Close as completed' }))
    await user.click(await screen.findByRole('button', { name: 'Apply again' }))
    expect(update.mock.calls[1]![0].expectedUpdatedAt).toBe('2026-01-05T00:00:00Z')
    expect(await screen.findByText('Closed as completed.')).toBeInTheDocument()
  })

  it('shows the missing-permission message and Open settings, and keeps the text', async () => {
    const onOpenSettings = vi.fn()
    const message = 'Your token can read this repository but not change issues.'
    const update = vi.fn().mockRejectedValue(new UpdateIssueError({ kind: 'no-permission', message, action: 'open-settings' }))
    const user = renderModal(update, base, { onOpenSettings })
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), '!')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText("Couldn't change the issue.")).toBeInTheDocument()
    expect(screen.getByText(new RegExp(message))).toBeInTheDocument()
    expect(screen.getByText(/Your text is not kept when this dialog closes; copy it first if you need it\./)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Crash!')
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('keeps the draft after writes-off and calls onUpdate again on the next press', async () => {
    const update = vi
      .fn<(input: UpdateIssueInput, current: Issue) => Promise<Issue>>()
      .mockRejectedValueOnce(updateIssueFailures.writesOff())
      .mockImplementationOnce(async (_input, now) => saved(now, { title: 'Crash!' }))
    const user = renderModal(update)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), '!')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/The admin has turned off changing issues/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Crash!')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(update).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('Title changed.')).toBeInTheDocument()
  })

  describe('when changes are turned off while the modal is open', () => {
    function renderSwitchable(update: IssueUpdater) {
      const props = {
        issue: base,
        repoFullName: 'acme/widgets',
        labelsByName: new Map(),
        fetchedAt: 0,
        launcherButtonRef: createRef<HTMLButtonElement>(),
        onClose: () => {},
      }
      const view = render(<IssueDetailModal {...props} onUpdate={update} />)
      return { view, props }
    }

    it('keeps the buttons, shows the writes-off notice and keeps focus in the dialog after a state change', async () => {
      const user = userEvent.setup()
      let rerenderOff = () => {}
      const update: IssueUpdater = async () => {
        rerenderOff()
        throw updateIssueFailures.writesOff()
      }
      const { view, props } = renderSwitchable(update)
      rerenderOff = () => view.rerender(<IssueDetailModal {...props} onUpdate={null} />)
      await user.click(screen.getByRole('button', { name: 'Close as completed' }))
      expect(await screen.findByText(/The admin has turned off changing issues/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Close as completed' })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled()
      await waitFor(() => expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement))
    })

    it('keeps Edit after Cancel when the draft was started before changes were turned off', async () => {
      const user = userEvent.setup()
      let rerenderOff = () => {}
      const update: IssueUpdater = async () => {
        rerenderOff()
        throw updateIssueFailures.writesOff()
      }
      const { view, props } = renderSwitchable(update)
      rerenderOff = () => view.rerender(<IssueDetailModal {...props} onUpdate={null} />)
      await user.click(screen.getByRole('button', { name: 'Edit' }))
      await user.type(screen.getByRole('textbox', { name: 'Title' }), '!')
      await user.click(screen.getByRole('button', { name: 'Save changes' }))
      expect(await screen.findByText(/The admin has turned off changing issues/)).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
      await waitFor(() => expect(focused).toContain('issue-edit-button'))
    })
  })

  it('discards the draft on Cancel and on Escape, and focuses Edit', async () => {
    const update = vi.fn()
    const onClose = vi.fn()
    const user = renderModal(update, base, { onClose })
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), '!')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await waitFor(() => expect(focused).toContain('issue-edit-button'))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Crash')
    await user.type(screen.getByRole('textbox', { name: 'Title' }), '?')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    await waitFor(() => expect(focused).toContain('issue-edit-button'))
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveBeenCalled()
  })

  it('aborts the request on Escape while sending and stays in edit mode', async () => {
    let signal: AbortSignal | undefined
    const update = vi.fn(
      (input: UpdateIssueInput) =>
        new Promise<Issue>((_resolve, reject) => {
          signal = input.signal
          input.signal?.addEventListener('abort', () => reject(updateIssueFailures.stoppedBeforeSend()))
        }),
    )
    const onClose = vi.fn()
    const user = renderModal(update, base, { onClose })
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), '!')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(signal).toBeDefined())
    await user.keyboard('{Escape}')
    expect(signal?.aborted).toBe(true)
    expect(await screen.findByText(/You stopped before anything was sent/)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Crash!')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('without a pasted token shows the notice and disables Edit and the state buttons', async () => {
    useSettings.setState({ token: '' })
    const onOpenSettings = vi.fn()
    const user = renderModal(vi.fn(), base, { onOpenSettings })
    expect(screen.getByText('A token with write access is needed.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close as completed' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Close as not planned' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Open settings' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('shows GitHub text as plain text, never as markup', async () => {
    const user = renderModal(vi.fn(), makeIssue(1, { title: 'T', body: '<img src=x onerror=alert(1)>' }))
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('textbox', { name: 'Description' })).toHaveValue('<img src=x onerror=alert(1)>')
    expect(document.querySelector('img[src="x"]')).toBeNull()
  })
})

describe('IssueCard details button', () => {
  const card = (issue: Issue, props: Partial<Parameters<typeof IssueCard>[0]> = {}) =>
    render(<IssueCard issue={issue} labelsByName={new Map()} {...props} />)

  it('calls onOpenDetails with its own button', async () => {
    const onOpenDetails = vi.fn()
    card(makeIssue(7), { onOpenDetails })
    const button = screen.getByRole('button', { name: 'Show details of issue #7' })
    expect(button).toHaveAttribute('data-issue-details', '7')
    await userEvent.setup().click(button)
    expect(onOpenDetails).toHaveBeenCalledWith(button)
  })

  it('is absent without a handler and on the drag overlay', () => {
    card(makeIssue(7))
    expect(screen.queryByRole('button', { name: /Show details/ })).not.toBeInTheDocument()
    card(makeIssue(8), { onOpenDetails: vi.fn(), isOverlay: true })
    expect(screen.queryByRole('button', { name: /Show details/ })).not.toBeInTheDocument()
  })

  it('is on closed cards too, and a duplicate close is a purple Closed tag', () => {
    card(makeIssue(9, { state: 'closed', stateReason: 'duplicate' }), { onOpenDetails: vi.fn() })
    expect(screen.getByRole('button', { name: 'Show details of issue #9' })).toBeInTheDocument()
    expect(screen.getByText('Closed').closest('.cds--tag')).toHaveClass('cds--tag--purple')
  })

  it('keeps the title link to GitHub', () => {
    card(makeIssue(7, { title: 'Fix' }), { onOpenDetails: vi.fn() })
    const title = screen.getByRole('link', { name: 'Fix' })
    expect(title).toHaveAttribute('href', 'https://github.com/acme/widgets/issues/7')
    expect(title).toHaveAttribute('rel', 'noreferrer')
  })
})
