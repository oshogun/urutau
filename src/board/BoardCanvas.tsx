import { Layer } from '@carbon/react'
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { useMemo, useState } from 'react'
import type { BucketContents } from '../domain/board'
import type { Bucket, Issue, Label } from '../domain/types'
import { BucketColumn } from './BucketColumn'
import { cardId, issueNumberOf } from './cardIds'
import { IssueCard } from './IssueCard'

/** Card ids per bucket id, in display order. */
type Columns = Record<string, string[]>

interface BoardCanvasProps {
  buckets: Bucket[]
  /** Filtered issues per bucket: what is on screen. */
  visible: BucketContents
  /** Unfiltered issues per bucket. */
  contents: BucketContents
  labelsByName: ReadonlyMap<string, Label>
  isFiltering: boolean
  onMoveIssue: (issueNumber: number, bucketId: string, beforeIssueNumber: number | null) => void
  onEditBucket: (bucket: Bucket) => void
  onMoveBucket: (bucketId: string, offset: -1 | 1) => void
  onDeleteBucket: (bucket: Bucket) => void
}

export function BoardCanvas({
  buckets,
  visible,
  contents,
  labelsByName,
  isFiltering,
  onMoveIssue,
  onEditBucket,
  onMoveBucket,
  onDeleteBucket,
}: BoardCanvasProps) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const settled = useMemo<Columns>(
    () =>
      Object.fromEntries(
        buckets.map((bucket) => [
          bucket.id,
          (visible.get(bucket.id) ?? []).map((issue) => cardId(issue.number)),
        ]),
      ),
    [buckets, visible],
  )

  const issuesById = useMemo(() => {
    const map = new Map<string, Issue>()
    for (const list of visible.values()) {
      for (const issue of list) map.set(cardId(issue.number), issue)
    }
    return map
  }, [visible])

  // While dragging, cards move between columns in this local copy; the board
  // config is only updated once, on drop.
  const [dragColumns, setDragColumns] = useState<Columns | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const columns = dragColumns ?? settled

  const bucketTitle = (bucketId: string | undefined) =>
    buckets.find((bucket) => bucket.id === bucketId)?.title ?? 'a bucket'

  function containerOf(cols: Columns, id: UniqueIdentifier): string | undefined {
    const key = String(id)
    if (key in cols) return key
    return Object.keys(cols).find((bucketId) => cols[bucketId].includes(key))
  }

  function reset() {
    setActiveId(null)
    setDragColumns(null)
  }

  function handleDragStart({ active }: DragStartEvent) {
    setActiveId(String(active.id))
    setDragColumns(settled)
  }

  function handleDragOver({ active, over }: DragOverEvent) {
    if (!over) return
    setDragColumns((previous) => {
      const cols = previous ?? settled
      const from = containerOf(cols, active.id)
      const to = containerOf(cols, over.id)
      if (!from || !to || from === to) return previous

      const activeKey = String(active.id)
      const target = cols[to]
      const overIndex = target.indexOf(String(over.id))
      const activeRect = active.rect.current.translated
      const below = activeRect !== null && activeRect.top > over.rect.top + over.rect.height / 2
      const insertAt = overIndex === -1 ? target.length : overIndex + (below ? 1 : 0)

      return {
        ...cols,
        [from]: cols[from].filter((id) => id !== activeKey),
        [to]: [...target.slice(0, insertAt), activeKey, ...target.slice(insertAt)],
      }
    })
  }

  function handleDragEnd({ active, over }: DragEndEvent) {
    const cols = dragColumns ?? settled
    reset()
    if (!over) return

    const bucketId = containerOf(cols, active.id)
    if (!bucketId) return
    const activeKey = String(active.id)
    let list = cols[bucketId]
    if (containerOf(cols, over.id) === bucketId && String(over.id) !== bucketId) {
      list = arrayMove(list, list.indexOf(activeKey), list.indexOf(String(over.id)))
    }

    const unchanged =
      containerOf(settled, active.id) === bucketId &&
      list.length === settled[bucketId].length &&
      list.every((id, index) => id === settled[bucketId][index])
    if (unchanged) return

    const next = list[list.indexOf(activeKey) + 1]
    onMoveIssue(issueNumberOf(active.id), bucketId, next ? issueNumberOf(next) : null)
  }

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up issue #${issueNumberOf(active.id)}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `Issue #${issueNumberOf(active.id)} is over ${bucketTitle(containerOf(columns, over.id))}.`
        : `Issue #${issueNumberOf(active.id)} is no longer over a bucket.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `Issue #${issueNumberOf(active.id)} was dropped in ${bucketTitle(containerOf(columns, over.id))}.`
        : `Issue #${issueNumberOf(active.id)} was dropped.`,
    onDragCancel: ({ active }) => `Moving issue #${issueNumberOf(active.id)} was cancelled.`,
  }

  const activeIssue = activeId ? issuesById.get(activeId) : undefined

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={reset}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            'To move an issue, press space or enter on its handle. Use the arrow keys to move it, space or enter to drop it, or escape to cancel.',
        },
      }}
    >
      <div className="board-canvas">
        {buckets.map((bucket) => (
          <BucketColumn
            key={bucket.id}
            bucket={bucket}
            cardIds={columns[bucket.id] ?? []}
            issuesById={issuesById}
            total={contents.get(bucket.id) ?? []}
            buckets={buckets}
            labelsByName={labelsByName}
            isFiltering={isFiltering}
            onMoveIssue={(issueNumber, bucketId) => onMoveIssue(issueNumber, bucketId, null)}
            onEdit={() => onEditBucket(bucket)}
            onMoveBucket={(offset) => onMoveBucket(bucket.id, offset)}
            onDelete={() => onDeleteBucket(bucket)}
          />
        ))}
      </div>
      <DragOverlay>
        {activeIssue ? (
          // Same layer as the cards inside a bucket, so the dragged card keeps its color.
          <Layer>
            <IssueCard issue={activeIssue} labelsByName={labelsByName} isOverlay />
          </Layer>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
