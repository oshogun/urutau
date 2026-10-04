import { Chat, Draggable, Maximize, Milestone } from '@carbon/icons-react'
import { Button, OverflowMenu, OverflowMenuItem, Tag, Tile } from '@carbon/react'
import type { HTMLAttributes } from 'react'
import { labelFor } from '../domain/labels'
import type { Bucket, Issue, Label } from '../domain/types'
import { avatarSrc, issueStateTag } from './issueDisplay'
import { LabelTag } from './LabelTag'

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
        {!closed && onMoveTo && moveTargets.length > 0 && !isOverlay && (
          <OverflowMenu
            size="sm"
            flipped
            aria-label={`Actions for issue #${issue.number}`}
            iconDescription={`Actions for issue #${issue.number}`}
          >
            {moveTargets.map((bucket) => (
              <OverflowMenuItem
                key={bucket.id}
                itemText={`Move to ${bucket.title}`}
                onClick={() => onMoveTo(bucket.id)}
              />
            ))}
          </OverflowMenu>
        )}
      </div>

      <a
        className="issue-card__title"
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        draggable={false}
      >
        {issue.title}
      </a>

      {issue.labels.length > 0 && (
        <ul className="issue-card__labels" aria-label="Labels">
          {issue.labels.map((name) => (
            <li key={name}>
              <LabelTag label={labelFor(name, labelsByName)} />
            </li>
          ))}
        </ul>
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
