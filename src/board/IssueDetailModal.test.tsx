import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Issue } from '../domain/types'
import { parseIssueBody } from '../markdown/issueBody'
import { parseBodyInWorker } from '../markdown/parseBodyInWorker'
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
