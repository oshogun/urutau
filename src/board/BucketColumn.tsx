import { CheckmarkOutline } from '@carbon/icons-react'
import { Layer, OverflowMenu, OverflowMenuItem, Tag } from '@carbon/react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Bucket, Issue, Label } from '../domain/types'
import { labelFor } from '../domain/labels'
import { cardId } from './cardIds'
import { IssueCard } from './IssueCard'
import { LabelTag } from './LabelTag'

interface BucketColumnProps {
  bucket: Bucket
  /** Card ids in display order (may differ from `issues` while dragging). */
  cardIds: string[]
  issuesById: ReadonlyMap<string, Issue>
  /** Issues in the bucket before filtering, for counts and the WIP limit. */
  total: Issue[]
  buckets: Bucket[]
  labelsByName: ReadonlyMap<string, Label>
  isFiltering: boolean
  onMoveIssue: (issueNumber: number, bucketId: string) => void
  onEdit: () => void
  onMoveBucket: (offset: -1 | 1) => void
  onDelete: () => void
}

export function BucketColumn({
  bucket,
  cardIds,
  issuesById,
  total,
  buckets,
  labelsByName,
  isFiltering,
  onMoveIssue,
  onEdit,
  onMoveBucket,
  onDelete,
}: BucketColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: bucket.id })
  const index = buckets.findIndex((candidate) => candidate.id === bucket.id)
  const openCount = total.filter((issue) => issue.state === 'open').length
  const overLimit = bucket.wipLimit !== null && openCount > bucket.wipLimit
  const headingId = `${bucket.id}-heading`
  const moveTargets = buckets.filter((candidate) => candidate.id !== bucket.id)

  // The WIP limit is about the bucket's real load, so it ignores filters.
  const count =
    bucket.wipLimit !== null
      ? {
          text: `${openCount}/${bucket.wipLimit}`,
          label: `${openCount} open issues, limit ${bucket.wipLimit}${overLimit ? ', over the limit' : ''}`,
        }
      : isFiltering
        ? {
            text: String(cardIds.length),
            label: `${cardIds.length} of ${total.length} issues match the filters`,
          }
        : { text: String(total.length), label: `${total.length} issue${total.length === 1 ? '' : 's'}` }

  return (
    <section className={`bucket${overLimit ? ' bucket--over-limit' : ''}`} aria-labelledby={headingId}>
      <header className="bucket__header">
        <h2 id={headingId} className="bucket__title" title={bucket.title}>
          {bucket.title}
        </h2>
        <Tag size="sm" type={overLimit ? 'red' : 'cool-gray'} aria-hidden="true">
          {count.text}
        </Tag>
        <span className="cds--visually-hidden">{count.label}</span>
        <OverflowMenu
          size="sm"
          flipped
          aria-label={`Options for ${bucket.title}`}
          iconDescription={`Options for ${bucket.title}`}
        >
          <OverflowMenuItem itemText="Edit bucket" onClick={onEdit} />
          <OverflowMenuItem
            itemText="Move left"
            disabled={index <= 0}
            onClick={() => onMoveBucket(-1)}
          />
          <OverflowMenuItem
            itemText="Move right"
            disabled={index === buckets.length - 1}
            onClick={() => onMoveBucket(1)}
          />
          <OverflowMenuItem
            itemText="Delete bucket"
            isDelete
            hasDivider
            disabled={buckets.length <= 1}
            onClick={onDelete}
          />
        </OverflowMenu>
      </header>

      {(bucket.labelRules.length > 0 || bucket.collectsClosed) && (
        <div className="bucket__rules">
          {bucket.collectsClosed && (
            <span className="bucket__rule-note">
              <CheckmarkOutline size={16} aria-hidden="true" />
              Closed issues
            </span>
          )}
          {bucket.labelRules.length > 0 && (
            <ul className="bucket__rule-labels" aria-label="Issues with these labels start here">
              {bucket.labelRules.map((name) => (
                <li key={name}>
                  <LabelTag label={labelFor(name, labelsByName)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Layer className="bucket__body">
        <SortableContext id={bucket.id} items={cardIds} strategy={verticalListSortingStrategy}>
          <ul
            ref={setNodeRef}
            className={`bucket__cards${isOver ? ' bucket__cards--over' : ''}`}
            aria-labelledby={headingId}
          >
            {cardIds.map((id) => {
              const issue = issuesById.get(id)
              return issue ? (
                <SortableIssueCard
                  key={id}
                  issue={issue}
                  labelsByName={labelsByName}
                  moveTargets={moveTargets}
                  onMoveTo={(bucketId) => onMoveIssue(issue.number, bucketId)}
                />
              ) : null
            })}
            {cardIds.length === 0 && (
              <li className="bucket__empty">
                {isFiltering && total.length > 0 ? 'No matching issues' : 'Drop issues here'}
              </li>
            )}
          </ul>
        </SortableContext>
      </Layer>
    </section>
  )
}

interface SortableIssueCardProps {
  issue: Issue
  labelsByName: ReadonlyMap<string, Label>
  moveTargets: Bucket[]
  onMoveTo: (bucketId: string) => void
}

function SortableIssueCard({ issue, labelsByName, moveTargets, onMoveTo }: SortableIssueCardProps) {
  const closed = issue.state === 'closed'
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: cardId(issue.number), disabled: closed })

  // Pointer drags work from anywhere on the card; keyboard drags start from the
  // handle only, so Space/Enter on the title link or menu keep their usual meaning.
  return (
    <li
      ref={setNodeRef}
      className={`bucket__card${isDragging ? ' bucket__card--placeholder' : ''}${closed ? '' : ' bucket__card--draggable'}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...listeners}
    >
      <IssueCard
        issue={issue}
        labelsByName={labelsByName}
        moveTargets={moveTargets}
        onMoveTo={onMoveTo}
        handleAttributes={closed ? undefined : attributes}
        handleRef={setActivatorNodeRef}
      />
    </li>
  )
}
