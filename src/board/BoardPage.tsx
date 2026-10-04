import { Button, InlineNotification, SkeletonPlaceholder, SkeletonText } from '@carbon/react'
import { useEffect, useRef, type ReactNode } from 'react'
import { createDefaultBoard } from '../domain/board'
import { formatRepo, repoKey } from '../domain/repoRef'
import type { RepoRef } from '../domain/types'
import { KeycloakButton } from '../components/auth/KeycloakButton'
import { GitHubError } from '../github/client'
import { useBoard, useClosedWindowDays } from '../hooks/useBoard'
import { useBoardEvents } from '../hooks/useBoardEvents'
import { useCreateIssue } from '../hooks/useCreateIssue'
import { useServerSettings } from '../hooks/useServerSettings'
import { useRepoSnapshot } from '../hooks/useRepoSnapshot'
import { useUpdateIssue } from '../hooks/useUpdateIssue'
import { useSession } from '../state/session'
import { readV1Board } from '../state/v1Import'
import { Board } from './Board'
import './board.scss'

interface BoardPageProps {
  repo: RepoRef
  onOpenSettings: () => void
  onChangeRepo: () => void
}

/**
 * Loads the board stored on the server first, so the GitHub request uses its closed-issue
 * window, then hands over to the page that loads the repository.
 */
export function BoardPage({ repo, onOpenSettings, onChangeRepo }: BoardPageProps) {
  const { status, loadError, load } = useBoard(repo)

  useEffect(() => {
    void load()
  }, [load])

  if (status === 'error') {
    return (
      <div className="board-message">
        <title>{`${formatRepo(repo)} · Urutau`}</title>
        <InlineNotification
          kind="error"
          hideCloseButton
          title={`Couldn't load the board for ${formatRepo(repo)}.`}
          subtitle={loadError ?? 'The Urutau server did not answer.'}
        />
        <div className="board-message__actions">
          <Button kind="primary" onClick={() => void load()}>
            Try again
          </Button>
          <Button kind="ghost" onClick={onChangeRepo}>
            Choose another repository
          </Button>
        </div>
      </div>
    )
  }
  if (status === 'loading') return <BoardSkeleton title={<title>{`${formatRepo(repo)} · Urutau`}</title>} />

  return <RepositoryBoard repo={repo} onOpenSettings={onOpenSettings} onChangeRepo={onChangeRepo} />
}

function RepositoryBoard({ repo, onOpenSettings, onChangeRepo }: BoardPageProps) {
  const key = repoKey(repo)
  const entry = useBoard(repo)
  const closedWindowDays = useClosedWindowDays(key)
  const query = useRepoSnapshot(repo, closedWindowDays)
  const creating = useRef(false)
  const serverMode = useSession((state) => state.session?.githubAccess.mode === 'server')
  const accessProblem = useSession((state) =>
    state.session?.githubAccess.mode === 'browser' ? state.session.githubAccess.problem : null,
  )
  const live = useBoardEvents(repo, entry.status !== 'loading')
  const { githubWrites } = useServerSettings()
  const createIssue = useCreateIssue(repo)
  const updateIssue = useUpdateIssue(repo)

  const { status, conflict, create } = entry
  const snapshot = query.data
  const deleted = status === 'missing' && conflict?.kind === 'deleted'

  // A repository joins the server's list the first time anyone opens it successfully. The new
  // board starts from this browser's version-1 board when there is one, else from the labels.
  useEffect(() => {
    if (status !== 'missing' || deleted || !snapshot || creating.current) return
    creating.current = true
    void create(readV1Board(key) ?? createDefaultBoard(snapshot.labels), snapshot.repository.fullName)
  }, [status, deleted, snapshot, create, key])

  const fullName = snapshot?.repository.fullName
  const title = <title>{`${fullName ?? formatRepo(repo)} · Urutau`}</title>

  if (snapshot && entry.board) {
    return (
      <>
        {title}
        <Board
          snapshot={snapshot}
          config={entry.board}
          onUpdateConfig={entry.update}
          conflict={conflict}
          onDismissConflict={entry.dismissConflict}
          saveError={entry.saveError}
          onRetrySave={entry.retrySave}
          live={live}
          isFetching={query.isFetching}
          refreshError={query.isError ? query.error : null}
          onRefresh={() => void query.refetch()}
          onCreateIssue={githubWrites ? createIssue : null}
          onUpdateIssue={githubWrites ? updateIssue : null}
          onOpenSettings={onOpenSettings}
        />
      </>
    )
  }

  if (deleted) {
    return (
      <div className="board-message">
        {title}
        <InlineNotification
          kind="warning"
          hideCloseButton
          title="Your last change wasn't saved."
          subtitle={`${conflict?.by ?? 'Someone else'} deleted this board.`}
        />
        <div className="board-message__actions">
          <Button
            kind="primary"
            disabled={!snapshot}
            onClick={() => {
              if (snapshot) {
                void create(createDefaultBoard(snapshot.labels), snapshot.repository.fullName)
              }
            }}
          >
            Start a new board
          </Button>
          <Button kind="ghost" onClick={onChangeRepo}>
            Choose another repository
          </Button>
        </div>
      </div>
    )
  }

  if (query.isError) {
    const error = query.error
    const serverAccess = error instanceof GitHubError && error.kind === 'server-access'
    // In server mode Settings has no token field, so it is no way out of any of these errors.
    const needsToken =
      !serverMode &&
      error instanceof GitHubError &&
      (error.needsToken || error.kind === 'rate-limited' || (serverAccess && error.problem !== 'unavailable'))
    const signInAgain =
      accessProblem === 'signin-expired' ||
      (serverAccess && error.problem === 'signin-expired') ||
      (serverMode && error instanceof GitHubError && error.kind === 'unauthorized')
    return (
      <div className="board-message">
        {title}
        <InlineNotification
          kind="error"
          hideCloseButton
          title={`Couldn't load ${formatRepo(repo)}.`}
          subtitle={error.message}
        />
        <div className="board-message__actions">
          <Button kind="primary" onClick={() => void query.refetch()}>
            Try again
          </Button>
          {signInAgain && <KeycloakButton kind="secondary">Sign in with Keycloak again</KeycloakButton>}
          {needsToken && (
            <Button kind="secondary" onClick={onOpenSettings}>
              Open settings
            </Button>
          )}
          <Button kind="ghost" onClick={onChangeRepo}>
            Choose another repository
          </Button>
        </div>
      </div>
    )
  }

  return <BoardSkeleton title={title} />
}

function BoardSkeleton({ title }: { title: ReactNode }) {
  return (
    <div className="board board--loading" aria-busy="true">
      {title}
      <div className="board-header">
        <SkeletonText heading width="20rem" />
      </div>
      <div className="board-canvas">
        {[0, 1, 2, 3].map((column) => (
          <div key={column} className="bucket">
            <div className="bucket__header">
              <SkeletonText width="8rem" />
            </div>
            <div className="bucket__cards">
              {[0, 1, 2].map((card) => (
                <SkeletonPlaceholder key={card} className="bucket__skeleton-card" />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
