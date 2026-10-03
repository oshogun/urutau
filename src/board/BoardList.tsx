import { Close } from '@carbon/icons-react'
import {
  ActionableNotification,
  ContainedList,
  ContainedListItem,
  IconButton,
  InlineNotification,
  Modal,
  SkeletonText,
  Tag,
} from '@carbon/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError, CLIENT_ID, apiRequest } from '../api/client'
import { CLIENT_ID_HEADER } from '../domain/api'
import type { BoardSummary } from '../domain/api'
import { parseRepoInput } from '../domain/repoRef'
import type { RepoRef } from '../domain/types'
import { BOARD_LIST_QUERY_KEY, useBoardList } from '../hooks/useBoardList'

interface BoardListProps {
  onOpen: (repo: RepoRef) => void
}

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** The boards stored on the server, most recently changed first, with delete. */
export function BoardList({ onOpen }: BoardListProps) {
  const queryClient = useQueryClient()
  const { data, isLoading, error, refetch } = useBoardList()
  const [pending, setPending] = useState<BoardSummary | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const remove = useMutation({
    mutationFn: (board: BoardSummary) =>
      apiRequest<void>(
        `boards/${board.repoKey.split('/').map(encodeURIComponent).join('/')}?version=${board.version}`,
        { method: 'DELETE', headers: { [CLIENT_ID_HEADER]: CLIENT_ID } },
      ),
    onSuccess: () => {
      setPending(null)
      setDeleteError(null)
    },
    onError: (failure) => {
      setPending(null)
      setDeleteError(
        failure instanceof ApiError && failure.status === 409
          ? 'Someone changed that board first, so it was not deleted. The list is up to date now.'
          : failure.message,
      )
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: BOARD_LIST_QUERY_KEY }),
  })

  function open(board: BoardSummary) {
    const repo = parseRepoInput(board.fullName)
    if (repo) onOpen(repo)
  }

  if (isLoading) {
    return (
      <div className="connect__recent" aria-busy="true" aria-label="Loading boards">
        <SkeletonText heading width="10rem" />
        <SkeletonText paragraph lineCount={3} />
      </div>
    )
  }

  if (error) {
    return (
      <ActionableNotification
        className="connect__recent-message"
        kind="error"
        lowContrast
        inline
        hideCloseButton
        title="Couldn't load the boards."
        subtitle={error.message}
        actionButtonLabel="Try again"
        onActionButtonClick={() => void refetch()}
      />
    )
  }

  const boards = data ?? []

  return (
    <>
      {deleteError && (
        <InlineNotification
          className="connect__recent-message"
          kind="error"
          lowContrast
          title="The board was not deleted."
          subtitle={deleteError}
          onClose={() => {
            setDeleteError(null)
            return false
          }}
        />
      )}
      {boards.length === 0 ? (
        <p className="connect__empty">
          No boards on this server yet. Open a repository above to create the first one.
        </p>
      ) : (
        <ContainedList label="Boards on this server" kind="on-page" className="connect__recent">
          {boards.map((board) => (
            <ContainedListItem
              key={board.repoKey}
              onClick={() => open(board)}
              action={
                <IconButton
                  kind="ghost"
                  size="sm"
                  align="left"
                  label={`Delete the board for ${board.fullName}`}
                  onClick={() => setPending(board)}
                >
                  <Close />
                </IconButton>
              }
            >
              <span className="connect__board-name">{board.fullName}</span>
              <span className="connect__board-meta">
                {board.updatedBy ? `Updated by ${board.updatedBy.username}` : 'Updated'}
                {board.updatedBy?.kind === 'integration' && (
                  <>
                    {' '}
                    <Tag as="span" type="cool-gray" size="sm">
                      Agent
                    </Tag>
                  </>
                )}{' '}
                on {formatWhen(board.updatedAt)}
              </span>
            </ContainedListItem>
          ))}
        </ContainedList>
      )}

      {pending && (
        <Modal
          open
          danger
          size="xs"
          modalHeading={`Delete the board for ${pending.fullName}?`}
          primaryButtonText="Delete board"
          secondaryButtonText="Cancel"
          primaryButtonDisabled={remove.isPending}
          onRequestSubmit={() => remove.mutate(pending)}
          onRequestClose={() => setPending(null)}
        >
          <p>
            Its buckets and card positions are removed for everyone on this server. Nothing changes
            on GitHub, and opening the repository again starts a new board.
          </p>
        </Modal>
      )}
    </>
  )
}
