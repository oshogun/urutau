import { Launch, Locked, Renew, Settings } from '@carbon/icons-react'
import {
  ActionableNotification,
  Button,
  InlineNotification,
  Link,
  Modal,
  Tag,
  ToastNotification,
} from '@carbon/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { claimIsLive, humanWaitState } from '../domain/activity'
import type { ClaimView, SetEstimateRequest } from '../domain/api'
import type { BoardEvents } from '../hooks/useBoardEvents'
import {
  createDefaultBoard,
  deleteBucket,
  moveBucket,
  moveIssue,
  resolveBuckets,
  saveBucket,
  type BucketContents,
} from '../domain/board'
import { EMPTY_FILTERS, isFiltering, matchesFilters } from '../domain/filters'
import { keepEstimates } from '../domain/estimates'
import { repoKey as repoKeyOf } from '../domain/repoRef'
import type { BoardConfig, Bucket, Issue, RepoRef, RepoSnapshot } from '../domain/types'
import { useBoardActivity } from '../hooks/useCardActivity'
import type { CreateIssueInput } from '../hooks/useCreateIssue'
import type { IssueUpdater } from '../hooks/useUpdateIssue'
import { useActivity } from '../state/activityStore'
import type { ConflictNotice } from '../state/boardStore'
import { useSession } from '../state/session'
import { BoardCanvas } from './BoardCanvas'
import { BoardSettingsModal } from './BoardSettingsModal'
import { BoardToolbar } from './BoardToolbar'
import { BucketEditorModal } from './BucketEditorModal'
import { CardSignalsContext, type CardSignals } from './cardSignals'
import { ClaimsModal } from './ClaimsModal'
import { CreateIssueModal, type IssueDraft } from './CreateIssueModal'
import { EstimateModal } from './EstimateModal'
import { IssueDetailModal } from './IssueDetailModal'
import { ReleaseClaimModal } from './ReleaseClaimModal'
import './board.scss'

interface BoardProps {
  repo: RepoRef
  snapshot: RepoSnapshot
  config: BoardConfig
  onUpdateConfig: (recipe: (current: BoardConfig) => BoardConfig) => void
  /** Set when the server refused the last change because someone else saved first. */
  conflict: ConflictNotice | null
  onDismissConflict: () => void
  /** Set when saving failed and the edit is still only on screen. */
  saveError: string | null
  onRetrySave: () => void
  live: BoardEvents
  isFetching: boolean
  refreshError: Error | null
  onRefresh: () => void
  /** Creates an issue and places it; null while creating issues is turned off or unavailable. */
  onCreateIssue: ((input: CreateIssueInput) => Promise<Issue>) | null
  /** Changes an issue on GitHub; null while changing issues is turned off or unavailable. */
  onUpdateIssue: IssueUpdater | null
  onOpenSettings: () => void
  /** Saves an issue's estimate, or removes it with null; rejects with the server's error. */
  onSetEstimate: (issue: number, request: SetEstimateRequest | null) => Promise<void>
}

type Dialog =
  | { kind: 'edit-bucket'; bucket: Bucket | null }
  | { kind: 'delete-bucket'; bucket: Bucket }
  | { kind: 'board-settings' }
  | { kind: 'issue-detail'; issue: Issue }
  | { kind: 'estimate'; issue: number }
  | { kind: 'release-claim'; issue: number; claim: ClaimView }
  | { kind: 'claims' }
  // `create` is kept here so the dialog survives the switch being turned off while it is open.
  | { kind: 'create-issue'; bucket: Bucket; create: (input: CreateIssueInput) => Promise<Issue> }

export function Board({
  repo,
  snapshot,
  config,
  onUpdateConfig: updateConfig,
  conflict,
  onDismissConflict,
  saveError,
  onRetrySave,
  live,
  isFetching,
  refreshError,
  onRefresh,
  onCreateIssue,
  onUpdateIssue,
  onOpenSettings,
  onSetEstimate,
}: BoardProps) {
  const { repository, issues, labels } = snapshot
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const closeDialog = () => setDialog(null)
  const [draft, setDraft] = useState<IssueDraft>({ title: '', body: '' })
  const [createdToast, setCreatedToast] = useState<{ issue: Issue; bucketTitle: string; hidden: boolean } | null>(
    null,
  )
  const createLauncher = useRef<HTMLButtonElement | null>(null)
  const detailLauncher = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!createdToast) return
    const timer = window.setTimeout(() => setCreatedToast(null), 6000)
    return () => window.clearTimeout(timer)
  }, [createdToast])
  // Show the toast for each new remote change; adjusted while rendering rather than in an effect.
  const [shownChange, setShownChange] = useState(live.lastRemoteChange)
  const [toastOpen, setToastOpen] = useState(false)
  if (live.lastRemoteChange !== shownChange) {
    setShownChange(live.lastRemoteChange)
    setToastOpen(live.lastRemoteChange !== null)
  }

  const signedIn = useSession((state) => state.status === 'signed-in')
  const activity = useBoardActivity(repo)
  // One clock for every card: ages and the wait limit are computed from it, so a card turns red
  // within a minute of passing the limit without a timer per card or a request.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  // A refetch or a card-activity event also reads the clock, so a new claim never shows a stale age.
  useEffect(() => useActivity.subscribe(() => setNow(Date.now())), [])
  const humanWaitLimit = config.humanWaitLimit ?? null
  const waitState = useMemo(
    () => humanWaitState([...activity.cards.values()], humanWaitLimit, now),
    [activity.cards, humanWaitLimit, now],
  )
  const liveClaims = [...activity.cards.values()].filter((card) => card.claim && claimIsLive(card.claim, now)).length
  const estimateLauncher = useRef<HTMLElement | null>(null)
  const claimsButton = useRef<HTMLButtonElement | null>(null)
  const releaseClaim = useCallback(
    (issue: number, runId: string) => useActivity.getState().release(repoKeyOf(repo), issue, runId),
    [repo],
  )
  const signals = useMemo<CardSignals>(
    () => ({
      estimates: config.estimates,
      activity: activity.cards,
      now,
      humanWaitLimit,
      onEditEstimate: (issue, launcher) => {
        estimateLauncher.current = launcher
        setDialog({ kind: 'estimate', issue })
      },
      onReleaseClaim: signedIn
        ? (issue) => {
            const claim = activity.cards.get(issue)?.claim
            if (claim) setDialog({ kind: 'release-claim', issue, claim })
          }
        : undefined,
    }),
    [config.estimates, activity.cards, now, humanWaitLimit, signedIn],
  )

  const contents = useMemo(() => resolveBuckets(issues, config), [issues, config])
  const filtering = isFiltering(filters)
  const visible = useMemo<BucketContents>(() => {
    if (!filtering) return contents
    return new Map(
      [...contents].map(([bucketId, list]) => [
        bucketId,
        list.filter((issue) => matchesFilters(issue, filters)),
      ]),
    )
  }, [contents, filters, filtering])
  const labelsByName = useMemo(() => new Map(labels.map((label) => [label.name, label])), [labels])

  const handleMoveIssue = useCallback(
    (issueNumber: number, bucketId: string, beforeIssueNumber: number | null) =>
      updateConfig((current) => moveIssue(current, issues, issueNumber, bucketId, beforeIssueNumber)),
    [issues, updateConfig],
  )

  const openCount = issues.filter((issue) => issue.state === 'open').length
  const closedCount = issues.length - openCount
  const syncedAt = new Date(snapshot.fetchedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  return (
    <CardSignalsContext value={signals}>
      <div className="board">
        <header className="board-header">
          <div className="board-header__title">
            <h1 className="board-header__name">
              <Link href={repository.url} target="_blank" rel="noreferrer" renderIcon={Launch}>
                {repository.fullName}
              </Link>
              {repository.isPrivate && (
                <Tag size="sm" type="outline" renderIcon={Locked}>
                  Private
                </Tag>
              )}
            </h1>
            {repository.description && (
              <p className="board-header__description">{repository.description}</p>
            )}
          </div>
          <div className="board-header__meta">
            <span className="board-header__counts">
              {openCount} open
              {config.closedWindowDays > 0 &&
                ` · ${closedCount} closed in the last ${config.closedWindowDays} days`}
              {' · '}synced {syncedAt}
            </span>
            {waitState.waiting > 0 && (
              <Tag size="sm" type={waitState.over > 0 ? 'red' : 'magenta'}>
                {waitState.over > 0
                  ? `${waitState.waiting} waiting on a human, ${waitState.over} over ${humanWaitLimit} h`
                  : `${waitState.waiting} waiting on a human`}
              </Tag>
            )}
            {liveClaims > 0 && (
              <Button ref={claimsButton} kind="ghost" size="sm" onClick={() => setDialog({ kind: 'claims' })}>
                Claims ({liveClaims})
              </Button>
            )}
            <Button
              kind="ghost"
              size="sm"
              renderIcon={Renew}
              onClick={onRefresh}
              disabled={isFetching}
              className={isFetching ? 'board-header__refresh--busy' : undefined}
            >
              {isFetching ? 'Syncing…' : 'Refresh'}
            </Button>
            <Button
              kind="ghost"
              size="sm"
              renderIcon={Settings}
              onClick={() => setDialog({ kind: 'board-settings' })}
            >
              Board settings
            </Button>
          </div>
        </header>

        {conflict && (
          <InlineNotification
            className="board__notice"
            kind="warning"
            lowContrast
            title="Your last change wasn't saved."
            subtitle={`${conflict.by ?? 'Someone else'} changed this board. It now shows their version.`}
            onClose={() => {
              onDismissConflict()
              return false
            }}
          />
        )}
        {saveError && (
          <ActionableNotification
            className="board__notice"
            kind="error"
            lowContrast
            inline
            hideCloseButton
            title="Your last change isn't saved yet."
            subtitle={saveError}
            actionButtonLabel="Retry"
            onActionButtonClick={onRetrySave}
          />
        )}
        {refreshError && (
          <InlineNotification
            className="board__notice"
            kind="error"
            lowContrast
            title="Couldn't refresh."
            subtitle={`${refreshError.message} Showing the last loaded issues.`}
          />
        )}
        {snapshot.truncated && (
          <InlineNotification
            className="board__notice"
            kind="warning"
            lowContrast
            title="Not every issue is shown."
            subtitle="This repository has more issues than Urutau loads at once (1,000 open and 1,000 recently closed)."
          />
        )}

        <BoardToolbar
          issues={issues}
          labels={labels}
          filters={filters}
          onFiltersChange={setFilters}
          onAddBucket={() => setDialog({ kind: 'edit-bucket', bucket: null })}
          connection={live.connection}
        />

        <BoardCanvas
          buckets={config.buckets}
          visible={visible}
          contents={contents}
          labelsByName={labelsByName}
          isFiltering={filtering}
          onMoveIssue={handleMoveIssue}
          onEditBucket={(bucket) => setDialog({ kind: 'edit-bucket', bucket })}
          onMoveBucket={(bucketId, offset) =>
            updateConfig((current) => moveBucket(current, bucketId, offset))
          }
          onDeleteBucket={(bucket) => setDialog({ kind: 'delete-bucket', bucket })}
          onOpenIssue={(issue, launcher) => {
            detailLauncher.current = launcher
            setDialog({ kind: 'issue-detail', issue })
          }}
          onCreateIssue={
            onCreateIssue
              ? (bucket, launcher) => {
                  createLauncher.current = launcher
                  setDialog({ kind: 'create-issue', bucket, create: onCreateIssue })
                }
              : null
          }
        />

        {(createdToast || (toastOpen && live.lastRemoteChange)) && (
          <div className="board-toasts">
            {createdToast && (
              <ActionableNotification
                className="board-toast"
                kind="success"
                lowContrast
                role="status"
                hasFocus={false}
                closeOnEscape={false}
                title={`Created issue #${createdToast.issue.number}`}
                subtitle={`Added to ${createdToast.bucketTitle}.${createdToast.hidden ? ' The current filters hide it.' : ''}`}
                actionButtonLabel="Open on GitHub"
                onActionButtonClick={() => window.open(createdToast.issue.url, '_blank', 'noopener,noreferrer')}
                onClose={() => {
                  setCreatedToast(null)
                  return false
                }}
              />
            )}
            {toastOpen && live.lastRemoteChange && (
              <ToastNotification
                className="board-toast"
                kind="info"
                lowContrast
                role="status"
                title={`Board updated by ${live.lastRemoteChange.by ?? 'a teammate'}`}
                timeout={4000}
                onClose={() => {
                  setToastOpen(false)
                  return false
                }}
              >
                {live.lastRemoteChange.kind === 'integration' && (
                  <Tag as="span" type="cool-gray" size="sm">
                    Agent
                  </Tag>
                )}
              </ToastNotification>
            )}
          </div>
        )}
        {dialog?.kind === 'create-issue' && (
          <CreateIssueModal
            fullName={repository.fullName}
            bucket={dialog.bucket}
            draft={draft}
            onDraftChange={setDraft}
            create={dialog.create}
            launcherButtonRef={createLauncher}
            onCreated={(issue) => {
              setDraft({ title: '', body: '' })
              setCreatedToast({
                issue,
                bucketTitle: dialog.bucket.title,
                hidden: filtering && !matchesFilters(issue, filters),
              })
              closeDialog()
              createLauncher.current?.focus()
            }}
            onClose={() => {
              closeDialog()
              createLauncher.current?.focus()
            }}
            onOpenSettings={() => {
              closeDialog()
              onOpenSettings()
            }}
            onRefresh={onRefresh}
          />
        )}
        {dialog?.kind === 'issue-detail' && (
          <IssueDetailModal
            issue={issues.find((candidate) => candidate.number === dialog.issue.number) ?? dialog.issue}
            repoFullName={repository.fullName}
            labelsByName={labelsByName}
            fetchedAt={snapshot.fetchedAt}
            estimate={config.estimates?.[dialog.issue.number] ?? null}
            now={now}
            launcherButtonRef={detailLauncher}
            onUpdate={onUpdateIssue}
            onOpenSettings={() => {
              closeDialog()
              onOpenSettings()
            }}
            onRefresh={onRefresh}
            onClose={() => {
              const number = dialog.issue.number
              closeDialog()
              const launcher = detailLauncher.current
              if (launcher?.isConnected) launcher.focus()
              else document.querySelector<HTMLElement>(`[data-issue-details="${number}"]`)?.focus()
            }}
          />
        )}
        {dialog?.kind === 'edit-bucket' && (
          <BucketEditorModal
            bucket={dialog.bucket}
            labels={labels}
            onSave={(bucket) => {
              updateConfig((current) => saveBucket(current, bucket))
              closeDialog()
            }}
            onClose={closeDialog}
          />
        )}
        {dialog?.kind === 'delete-bucket' && (
          <Modal
            open
            danger
            size="xs"
            modalHeading={`Delete “${dialog.bucket.title}”?`}
            primaryButtonText="Delete bucket"
            secondaryButtonText="Cancel"
            onRequestSubmit={() => {
              updateConfig((current) => deleteBucket(current, dialog.bucket.id))
              closeDialog()
            }}
            onRequestClose={closeDialog}
          >
            <p>
              Its issues go back to automatic placement: a matching label rule, otherwise the first
              bucket. Nothing changes on GitHub.
            </p>
          </Modal>
        )}
        {dialog?.kind === 'board-settings' && (
          <BoardSettingsModal
            repoName={repository.fullName}
            config={config}
            onSave={(next) => updateConfig(() => next)}
            onReset={() => updateConfig((current) => keepEstimates(createDefaultBoard(labels), current))}
            onClose={closeDialog}
          />
        )}
        {dialog?.kind === 'estimate' && (
          <EstimateModal
            issue={dialog.issue}
            estimate={config.estimates?.[dialog.issue] ?? null}
            onSave={onSetEstimate}
            onClose={() => {
              const number = dialog.issue
              closeDialog()
              const launcher = estimateLauncher.current
              if (launcher?.isConnected) launcher.focus()
              else document.querySelector<HTMLElement>(`[data-issue-details="${number}"]`)?.focus()
            }}
          />
        )}
        {dialog?.kind === 'release-claim' && (
          <ReleaseClaimModal
            issue={dialog.issue}
            claim={dialog.claim}
            now={now}
            onRelease={releaseClaim}
            onClose={closeDialog}
          />
        )}
        {dialog?.kind === 'claims' && (
          <ClaimsModal
            repoFullName={repository.fullName}
            cards={activity.cards}
            humanWaitLimit={humanWaitLimit}
            now={now}
            onRelease={signedIn ? releaseClaim : undefined}
            onClose={() => {
            closeDialog()
            claimsButton.current?.focus()
          }}
          />
        )}
      </div>
    </CardSignalsContext>
  )
}
