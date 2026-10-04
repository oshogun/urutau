import { Chat, Launch, Milestone } from '@carbon/icons-react'
import { Layer, Link, Modal, Tag } from '@carbon/react'
import type { RefObject } from 'react'
import { labelFor } from '../domain/labels'
import type { Issue, Label, User } from '../domain/types'
import { IssueBody } from './IssueBody'
import { avatarSrc, issueStateTag } from './issueDisplay'
import { LabelTag } from './LabelTag'

export interface IssueDetailModalProps {
  issue: Issue
  repoFullName: string
  labelsByName: ReadonlyMap<string, Label>
  /** `snapshot.fetchedAt`, epoch milliseconds. */
  fetchedAt: number
  /** Board's ref to the details button that opened the modal; passed to Carbon's `Modal`. */
  launcherButtonRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
}

function DateText({ iso }: { iso: string }) {
  const date = new Date(iso)
  return (
    <time dateTime={iso} title={date.toLocaleString()}>
      {date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
    </time>
  )
}

function Person({ user }: { user: User }) {
  return (
    <span className="issue-detail__person">
      <img src={avatarSrc(user.avatarUrl)} alt="" width={20} height={20} loading="lazy" />
      {user.login}
    </span>
  )
}

export function IssueDetailModal({
  issue,
  repoFullName,
  labelsByName,
  fetchedAt,
  launcherButtonRef,
  onClose,
}: IssueDetailModalProps) {
  const label = `${repoFullName} #${issue.number}`
  const tag = issueStateTag(issue.state, issue.stateReason)
  const hasFields = issue.labels.length > 0 || issue.assignees.length > 0 || issue.milestone !== null
  const loadedAt = new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  return (
    <Modal
      open
      passiveModal
      size="lg"
      hasScrollingContent
      modalLabel={label}
      aria-label={label}
      modalHeading={issue.title}
      closeButtonLabel="Close"
      selectorPrimaryFocus=".cds--modal-content"
      launcherButtonRef={launcherButtonRef}
      onRequestClose={onClose}
    >
      <div className="issue-detail__facts">
        <Tag size="sm" type={tag.type}>
          {tag.long}
        </Tag>
        <span>
          Opened <DateText iso={issue.createdAt} />
          {issue.author && (
            <>
              {' by '}
              <Person user={issue.author} />
            </>
          )}
        </span>
        {issue.state === 'closed' && issue.closedAt && (
          <span>
            Closed <DateText iso={issue.closedAt} />
          </span>
        )}
        <span>
          Updated <DateText iso={issue.updatedAt} />
        </span>
        <span className="issue-detail__comments">
          <Chat size={16} aria-hidden="true" />
          {issue.comments === 0
            ? 'No comments'
            : `${issue.comments} comment${issue.comments === 1 ? '' : 's'}`}
        </span>
        <Link href={issue.url} target="_blank" rel="noreferrer" renderIcon={Launch} size="sm">
          Open on GitHub
        </Link>
      </div>

      {hasFields && (
        <dl className="issue-detail__fields">
          {issue.labels.length > 0 && (
            <div className="issue-detail__field">
              <dt>Labels</dt>
              <dd>
                <ul className="issue-detail__labels">
                  {issue.labels.map((name) => (
                    <li key={name}>
                      <LabelTag label={labelFor(name, labelsByName)} />
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {issue.assignees.length > 0 && (
            <div className="issue-detail__field">
              <dt>Assignees</dt>
              <dd>
                <ul className="issue-detail__people">
                  {issue.assignees.map((assignee) => (
                    <li key={assignee.login}>
                      <Person user={assignee} />
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {issue.milestone !== null && (
            <div className="issue-detail__field">
              <dt>Milestone</dt>
              <dd>
                <span className="issue-detail__milestone">
                  <Milestone size={16} aria-hidden="true" />
                  {issue.milestone}
                </span>
              </dd>
            </div>
          )}
        </dl>
      )}

      <div className="issue-detail__body">
        <Layer>
          <IssueBody body={issue.body ?? ''} issueUrl={issue.url} />
        </Layer>
      </div>

      <p className="issue-detail__synced">Loaded with the board at {loadedAt}.</p>
    </Modal>
  )
}
