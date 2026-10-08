import { Accordion, AccordionItem, Button, InlineNotification, Link, Tag } from '@carbon/react'
import { useState } from 'react'
import { ApiError } from '../api/client'
import { statusLabel } from '../domain/activity'
import type { RunDetailView, UnverifiedItemView } from '../domain/api'
import { holderName, httpsLink } from './runDisplay'

function RunDate({ iso }: { iso: string }) {
  const date = new Date(iso)
  return (
    <time dateTime={iso} title={date.toLocaleString()}>
      {date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })}
    </time>
  )
}

/** The findings of a run that only answered a question: a link only when the whole value is one https URL. */
function Findings({ value }: { value: string }) {
  const href = httpsLink(value)
  return href ? (
    <Link href={href} target="_blank" rel="noreferrer">
      {href}
    </Link>
  ) : (
    <span>{value}</span>
  )
}

interface ItemRowProps {
  item: UnverifiedItemView
  busy: boolean
  /** Absent for anyone who cannot accept items. */
  onAccept?: (item: UnverifiedItemView) => void
}

function ItemRow({ item, busy, onAccept }: ItemRowProps) {
  const withdrawn = item.withdrawnAt !== null
  let state: React.ReactNode
  if (withdrawn && item.withdrawnAt) {
    state = (
      <>
        Withdrawn by the agent · <RunDate iso={item.withdrawnAt} />
      </>
    )
  } else if (item.resolution?.kind === 'probe') {
    state = (
      <>
        Checked by a probe
        {item.resolution.note ? `: ${item.resolution.note}` : ''} · <RunDate iso={item.resolution.at} />
      </>
    )
  } else if (item.resolution?.kind === 'accepted') {
    state = (
      <>
        Accepted by {item.resolution.by ? item.resolution.by.username : 'a removed account'}
        {item.resolution.note ? `: ${item.resolution.note}` : ''} · <RunDate iso={item.resolution.at} />
      </>
    )
  } else if (item.kind === 'normative' && onAccept) {
    state = (
      <Button
        kind="tertiary"
        size="sm"
        disabled={busy}
        aria-label={`Accept: ${item.text}`}
        onClick={() => onAccept(item)}
      >
        Accept
      </Button>
    )
  } else {
    state = 'Open'
  }
  return (
    <li className={`run-item${withdrawn ? ' run-item--withdrawn' : ''}`}>
      <Tag size="sm" type="gray">
        {item.kind}
      </Tag>
      <span className="run-item__text">{item.text}</span>
      <span className="run-item__state">{state}</span>
    </li>
  )
}

interface RunBlockProps {
  run: RunDetailView
  busyItem: string | null
  onAccept?: (item: UnverifiedItemView) => void
}

function RunBlock({ run, busyItem, onAccept }: RunBlockProps) {
  return (
    <div className="run-block">
      <p className="run-block__line">
        {statusLabel(run.status)} · run {run.runId} · {holderName(run.agent)} · started{' '}
        <RunDate iso={run.startedAt} />
      </p>
      {run.observedBy && <p className="run-block__note">Observed by {run.observedBy}</p>}
      {run.status === 'plan_only' && (
        <p className="run-block__note">
          Question answered{run.findings ? ': ' : ''}
          {run.findings && <Findings value={run.findings} />}
        </p>
      )}
      {run.items.length > 0 && (
        <ul className="run-items" aria-label={`Unverified items of run ${run.runId}`}>
          {run.items.map((item) => (
            <ItemRow key={item.id} item={item} busy={busyItem === item.id} onAccept={onAccept} />
          ))}
        </ul>
      )}
    </div>
  )
}

interface AgentRunsProps {
  runs: RunDetailView[]
  moreRuns: boolean
  /** Accepts a normative item; absent for anyone who cannot. Rejects with the server's error. */
  onAccept?: (runId: string, itemId: string) => Promise<void>
}

export function AgentRuns({ runs, moreRuns, onAccept }: AgentRunsProps) {
  const [busyItem, setBusyItem] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (runs.length === 0) return null
  const [last, ...earlier] = runs

  const accept = onAccept
    ? async (item: UnverifiedItemView) => {
        setBusyItem(item.id)
        setError(null)
        try {
          await onAccept(item.runId, item.id)
        } catch (failure) {
          setError(
            failure instanceof ApiError && failure.code === 'item-resolved'
              ? 'This item was already closed. The list shows its current state.'
              : failure instanceof Error
                ? failure.message
                : 'The item could not be accepted.',
          )
        } finally {
          setBusyItem(null)
        }
      }
    : undefined

  return (
    <section className="issue-detail__runs" aria-labelledby="issue-detail-runs">
      <h3 id="issue-detail-runs" className="issue-detail__runs-heading">
        Agent runs
      </h3>
      {error && (
        <InlineNotification
          kind="warning"
          lowContrast
          title="Not accepted."
          subtitle={error}
          onClose={() => {
            setError(null)
            return false
          }}
        />
      )}
      <RunBlock run={last} busyItem={busyItem} onAccept={accept} />
      {earlier.length > 0 && (
        <Accordion>
          <AccordionItem title={`Earlier runs (${earlier.length})`}>
            {earlier.map((run) => (
              <RunBlock key={run.runId} run={run} busyItem={busyItem} onAccept={accept} />
            ))}
          </AccordionItem>
        </Accordion>
      )}
      {moreRuns && <p className="run-block__note">Only the 20 most recent runs are shown.</p>}
    </section>
  )
}
