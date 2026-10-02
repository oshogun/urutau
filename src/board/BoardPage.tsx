import { Button, InlineNotification, SkeletonPlaceholder, SkeletonText } from '@carbon/react'
import { useEffect } from 'react'
import { formatRepo, repoKey } from '../domain/repoRef'
import type { RepoRef } from '../domain/types'
import { GitHubError } from '../github/client'
import { useRepoSnapshot } from '../hooks/useRepoSnapshot'
import { useClosedWindowDays } from '../state/boards'
import { useSettings } from '../state/settings'
import { Board } from './Board'
import './board.scss'

interface BoardPageProps {
  repo: RepoRef
  onOpenSettings: () => void
  onChangeRepo: () => void
}

export function BoardPage({ repo, onOpenSettings, onChangeRepo }: BoardPageProps) {
  const key = repoKey(repo)
  const closedWindowDays = useClosedWindowDays(key)
  const query = useRepoSnapshot(repo, closedWindowDays)
  const rememberRepo = useSettings((state) => state.rememberRepo)

  const fullName = query.data?.repository.fullName
  useEffect(() => {
    if (fullName) rememberRepo(fullName)
  }, [fullName, rememberRepo])

  const title = <title>{`${fullName ?? formatRepo(repo)} · Urutau`}</title>

  if (query.data) {
    return (
      <>
        {title}
        <Board
          boardKey={key}
          snapshot={query.data}
          isFetching={query.isFetching}
          refreshError={query.isError ? query.error : null}
          onRefresh={() => void query.refetch()}
        />
      </>
    )
  }

  if (query.isError) {
    const error = query.error
    const needsToken = error instanceof GitHubError && (error.needsToken || error.kind === 'rate-limited')
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
