import { Chat, Draggable, Flag, Maximize, Milestone } from '@carbon/icons-react'
import { Button, OperationalTag, OverflowMenu, OverflowMenuItem, Tag, Tile } from '@carbon/react'
import type { HTMLAttributes } from 'react'
import { claimIsLive, triageFlagText, unverifiedFlagText } from '../domain/activity'
import { estimateLabel, isEstimate } from '../domain/estimates'
import { labelFor } from '../domain/labels'
import type { Bucket, Issue, Label } from '../domain/types'
import { useCardSignals } from './cardSignals'
import { avatarSrc, issueStateTag } from './issueDisplay'
import { LabelTag } from './LabelTag'
import { CLAIM_TAG_TYPE, claimText, claimTone, estimateDescription, holderName } from './runDisplay'

interface IssueCardProps {
  issue: Issue
  labelsByName: ReadonlyMap<string, Label>
  /** Other buckets the issue can be sent to from its menu. */
  moveTargets?: Bucket[]
  onMoveTo?: (bucketId: string) => void
  /** Accessibility attributes for the keyboard drag handle; no handle without them. */
  handleAttributes?: HTMLAttributes<HTMLButtonElement>
  handleRef?: (element: HTMLElement | null) => void
  isOverlay?: boolean
  /** When given and `isOverlay` is false, the card shows the details button. */
  onOpenDetails?: (launcher: HTMLButtonElement) => void
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

function timeAgo(iso: string): string {
  const days = Math.round((Date.parse(iso) - Date.now()) / 86_400_000)
  if (Math.abs(days) < 1) return 'today'
  if (Math.abs(days) < 30) return relativeTime.format(days, 'day')
  if (Math.abs(days) < 365) return relativeTime.format(Math.round(days / 30), 'month')
  return relativeTime.format(Math.round(days / 365), 'year')
}

export function IssueCard({
  issue,
  labelsByName,
  moveTargets = [],
  onMoveTo,
  handleAttributes,
  handleRef,
  isOverlay = false,
  onOpenDetails,
}: IssueCardProps) {
  const closed = issue.state === 'closed'
  const tag = issueStateTag(issue.state, issue.stateReason)
  const { estimates, activity, now, humanWaitLimit, onEditEstimate, onReleaseClaim } = useCardSignals()
  const stored = estimates?.[issue.number]
  const estimate = isEstimate(stored) ? stored : null
  const card = activity.get(issue.number)
  const claim = card?.claim && claimIsLive(card.claim, now) ? card.claim : null
  const lastRun = card?.lastRun ?? null
  const triage = triageFlagText(estimate, lastRun?.triageRange ?? null)
  const unverified = lastRun ? unverifiedFlagText(lastRun.unverifiedOpen) : null
  const answered = lastRun?.status === 'plan_only' && claim === null
  const hasSignals = estimate !== null || triage !== null || claim !== null || unverified !== null || answered
  const tone = claim ? claimTone(claim, humanWaitLimit, now) : 'running'
  const canMove = !closed && onMoveTo !== undefined && moveTargets.length > 0
  const canEstimate = onEditEstimate !== undefined
  const canRelease = claim !== null && onReleaseClaim !== undefined
  const className = ['issue-card', closed && 'issue-card--closed', isOverlay && 'issue-card--overlay']
    .filter(Boolean)
    .join(' ')

  return (
    <Tile className={className}>
      <div className="issue-card__top">
        {handleAttributes && (
          <button
            ref={handleRef}
            type="button"
            className="issue-card__handle"
            aria-label={`Move issue #${issue.number}`}
            {...handleAttributes}
          >
            <Draggable size={16} />
          </button>
        )}
        <span className="issue-card__number">
          #{issue.number}
          <span className="issue-card__age">
            {' · '}
            {closed && issue.closedAt
              ? `closed ${timeAgo(issue.closedAt)}`
              : `opened ${timeAgo(issue.createdAt)}`}
          </span>
        </span>
        {closed && (
          <Tag size="sm" type={tag.type}>
            {tag.short}
          </Tag>
        )}
        {!isOverlay && (canMove || canEstimate || canRelease) && (
          <OverflowMenu
            size="sm"
            flipped
            aria-label={`Actions for issue #${issue.number}`}
            iconDescription={`Actions for issue #${issue.number}`}
          >
            {canMove &&
              moveTargets.map((bucket) => (
                <OverflowMenuItem
                  key={bucket.id}
                  itemText={`Move to ${bucket.title}`}
                  onClick={() => onMoveTo?.(bucket.id)}
                />
              ))}
            {canEstimate && (
              <OverflowMenuItem
                itemText={estimate ? 'Change estimate…' : 'Set estimate…'}
                hasDivider={canMove}
                onClick={() => onEditEstimate(issue.number, null)}
              />
            )}
            {canRelease && (
              <OverflowMenuItem
                itemText="Release claim…"
                isDelete
                hasDivider
                onClick={() => onReleaseClaim(issue.number)}
              />
            )}
          </OverflowMenu>
        )}
      </div>

      <div className="issue-card__heading">
        <a
          className="issue-card__title"
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          draggable={false}
        >
          {issue.title}
        </a>
        {onOpenDetails && !isOverlay && (
          <Button
            className="issue-card__details"
            data-issue-details={issue.number}
            kind="ghost"
            size="sm"
            hasIconOnly
            renderIcon={Maximize}
            iconDescription={`Show details of issue #${issue.number}`}
            tooltipPosition="bottom"
            onClick={(event) => onOpenDetails(event.currentTarget)}
          />
        )}
      </div>

      {issue.labels.length > 0 && (
        <ul className="issue-card__labels" aria-label="Labels">
          {issue.labels.map((name) => (
            <li key={name}>
              <LabelTag label={labelFor(name, labelsByName)} />
            </li>
          ))}
        </ul>
      )}

      {hasSignals && (
        <div className="issue-card__signals">
          {estimate &&
            (onEditEstimate && !isOverlay ? (
              <OperationalTag
                size="sm"
                type="cool-gray"
                text={estimateLabel(estimate)}
                aria-label={`${estimateDescription(estimate)}. Change estimate`}
                onClick={(event: React.MouseEvent<HTMLElement>) => onEditEstimate(issue.number, event.currentTarget)}
              />
            ) : (
              <Tag size="sm" type="cool-gray" title={estimateDescription(estimate)}>
                {estimateLabel(estimate)}
              </Tag>
            ))}
          {triage && (
            <Tag size="sm" type="outline">
              {triage}
            </Tag>
          )}
          {claim && (
            <Tag
              size="sm"
              type={CLAIM_TAG_TYPE[tone]}
            >
              <span
                title={`Claimed by ${holderName(claim.holder)} for run ${claim.runId}${
                  tone === 'over-limit' ? ` · waiting longer than ${humanWaitLimit} h` : ''
                }`}
              >
                {claimText(claim, now)}
                {tone === 'over-limit' && (
                  <span className="cds--visually-hidden">
                    , waiting longer than {humanWaitLimit} {humanWaitLimit === 1 ? 'hour' : 'hours'}
                  </span>
                )}
              </span>
            </Tag>
          )}
          {unverified && (
            // Carbon draws a tag's icon only on larger tags, so the flag is part of the text here.
            <Tag size="sm" type="warm-gray">
              <Flag size={12} className="issue-card__flag" aria-hidden="true" />
              {unverified}
            </Tag>
          )}
          {answered && (
            <Tag size="sm" type="teal">
              Question answered
            </Tag>
          )}
        </div>
      )}

      {(issue.milestone || issue.comments > 0 || issue.assignees.length > 0) && (
        <div className="issue-card__footer">
          {issue.milestone && (
            <span className="issue-card__meta" title="Milestone">
              <Milestone size={16} aria-hidden="true" />
              {issue.milestone}
            </span>
          )}
          {issue.comments > 0 && (
            <span
              className="issue-card__meta"
              title={`${issue.comments} comment${issue.comments === 1 ? '' : 's'}`}
            >
              <Chat size={16} aria-hidden="true" />
              {issue.comments}
            </span>
          )}
          {issue.assignees.length > 0 && (
            <span className="issue-card__assignees">
              {issue.assignees.slice(0, 3).map((assignee) => (
                <img
                  key={assignee.login}
                  src={avatarSrc(assignee.avatarUrl)}
                  alt={assignee.login}
                  title={assignee.login}
                  width={20}
                  height={20}
                  loading="lazy"
                  draggable={false}
                />
              ))}
              {issue.assignees.length > 3 && (
                <span className="issue-card__more">+{issue.assignees.length - 3}</span>
              )}
            </span>
          )}
        </div>
      )}
    </Tile>
  )
}
