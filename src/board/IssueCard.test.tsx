import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { CardActivity } from '../domain/api'
import type { Estimate } from '../domain/types'
import { makeClaim, makeIssue } from '../test/fixtures'
import { CardSignalsContext, type CardSignals } from './cardSignals'
import { IssueCard } from './IssueCard'

const NOW = Date.parse('2026-10-08T15:00:00.000Z')
const estimate = (size: Estimate['size'], confidence: Estimate['confidence']): Estimate => ({
  size,
  confidence,
  by: 'ada',
  at: '2026-10-08T10:00:00.000Z',
})

function renderCard(signals: Partial<CardSignals>) {
  const value: CardSignals = {
    estimates: undefined,
    activity: new Map(),
    now: NOW,
    humanWaitLimit: null,
    ...signals,
  }
  return render(
    <CardSignalsContext value={value}>
      <IssueCard issue={makeIssue(7)} labelsByName={new Map()} />
    </CardSignalsContext>,
  )
}

describe('IssueCard signals', () => {
  it.each([
    [estimate('M', 'sure'), 'M', 'Estimate: medium, sure. Change estimate'],
    [estimate('M', 'unsure'), 'M?', 'Estimate: medium, unsure. Change estimate'],
    [estimate(null, 'no-idea'), '?', 'Estimate: no idea. Change estimate'],
  ])('shows the estimate as %j', (stored, text, name) => {
    renderCard({ estimates: { 7: stored }, onEditEstimate: () => {} })
    const tag = screen.getByRole('button', { name })
    expect(tag).toHaveTextContent(new RegExp(`^${text.replace('?', '\\?')}$`))
  })

  it('shows no signal row for a card without an estimate or activity', () => {
    const { container } = renderCard({})
    expect(container.querySelector('.issue-card__signals')).toBeNull()
  })

  it('shows the claim age, the unverified flag and the triage flag', () => {
    const activity = new Map<number, CardActivity>([
      [
        7,
        {
          issue: 7,
          claim: makeClaim('r-1', {
            since: '2026-10-08T14:48:00.000Z',
            leaseUntil: '2026-10-08T15:30:00.000Z',
          }),
          lastRun: {
            runId: 'r-1',
            status: 'running',
            statusAt: '2026-10-08T14:48:00.000Z',
            startedAt: '2026-10-08T14:48:00.000Z',
            endedAt: null,
            triageRange: 'M-L',
            unverifiedOpen: { external: 2, normative: 0, untested: 0 },
          },
        },
      ],
    ])
    renderCard({ estimates: { 7: estimate('S', 'unsure') }, activity })
    expect(screen.getByText('Running · 12 min')).toBeInTheDocument()
    expect(screen.getByText('2 unverified (external)')).toBeInTheDocument()
    expect(screen.getByText('triage: M–L')).toBeInTheDocument()
    expect(screen.getByText('S?')).toBeInTheDocument()
  })

  it('turns a waiting claim over the limit red and says so in text', () => {
    const activity = new Map<number, CardActivity>([
      [
        7,
        {
          issue: 7,
          claim: makeClaim('r-2', {
            status: 'needs_human',
            since: '2026-10-08T01:00:00.000Z',
            leaseUntil: null,
          }),
          lastRun: null,
        },
      ],
    ])
    renderCard({ activity, humanWaitLimit: 4 })
    const tag = screen.getByText(/Needs a human · 14 h/)
    expect(tag.closest('.cds--tag')).toHaveClass('cds--tag--red')
    expect(tag).toHaveTextContent('waiting longer than 4 hours')
    expect(screen.getByTitle('Claimed by carcara for run r-2 · waiting longer than 4 h')).toBeInTheDocument()
  })

  it('offers Release claim only when a release handler is given', () => {
    // The overflow menu items render when the menu opens; the handler's presence decides whether the menu exists.
    const claimed = new Map<number, CardActivity>([
      [7, { issue: 7, claim: makeClaim('r-1', { leaseUntil: null }), lastRun: null }],
    ])
    const { container } = renderCard({ activity: claimed })
    expect(container.querySelector('[aria-label="Actions for issue #7"]')).toBeNull()
  })
})
