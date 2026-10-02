import { Add, FilterRemove } from '@carbon/icons-react'
import { Button, Dropdown, FilterableMultiSelect, Search, Tag } from '@carbon/react'
import { useMemo } from 'react'
import { NONE, countLabels, isFiltering, type BoardFilters } from '../domain/filters'
import type { Issue, Label } from '../domain/types'
import type { BoardConnection } from '../hooks/useBoardEvents'

const CONNECTION_TAG = {
  live: { type: 'green', text: 'Live' },
  reconnecting: { type: 'gray', text: 'Reconnecting' },
  offline: { type: 'red', text: 'Offline' },
} as const

interface Option {
  value: string | null
  text: string
}

interface LabelOption extends Label {
  count: number
}

interface BoardToolbarProps {
  issues: Issue[]
  labels: Label[]
  filters: BoardFilters
  onFiltersChange: (filters: BoardFilters) => void
  onAddBucket: () => void
  connection: BoardConnection
}

export function BoardToolbar({
  issues,
  labels,
  filters,
  onFiltersChange,
  onAddBucket,
  connection,
}: BoardToolbarProps) {
  const labelOptions = useMemo<LabelOption[]>(() => {
    const counts = countLabels(issues)
    return labels.map((label) => ({ ...label, count: counts.get(label.name) ?? 0 }))
  }, [issues, labels])

  const assigneeOptions = useMemo<Option[]>(() => {
    const logins = new Set(issues.flatMap((issue) => issue.assignees.map((user) => user.login)))
    return [
      { value: null, text: 'Anyone' },
      { value: NONE, text: 'Unassigned' },
      ...[...logins].sort((a, b) => a.localeCompare(b)).map((login) => ({ value: login, text: login })),
    ]
  }, [issues])

  const milestoneOptions = useMemo<Option[]>(() => {
    const titles = new Set(issues.flatMap((issue) => (issue.milestone ? [issue.milestone] : [])))
    return [
      { value: null, text: 'Any milestone' },
      { value: NONE, text: 'No milestone' },
      ...[...titles].sort((a, b) => a.localeCompare(b)).map((title) => ({ value: title, text: title })),
    ]
  }, [issues])

  const update = (patch: Partial<BoardFilters>) => onFiltersChange({ ...filters, ...patch })

  return (
    <div className="board-toolbar" role="search" aria-label="Filter issues">
      <Search
        id="board-search"
        className="board-toolbar__search"
        size="md"
        labelText="Search issues"
        placeholder="Search by title, #number or author"
        value={filters.text}
        onChange={(event) => update({ text: event.target.value })}
        closeButtonLabelText="Clear search"
      />
      <div className="board-toolbar__field board-toolbar__field--labels">
        <FilterableMultiSelect<LabelOption>
          id="board-labels"
          titleText="Labels"
          hideLabel
          placeholder="Filter by label"
          size="md"
          items={labelOptions}
          itemToString={(item) => item?.name ?? ''}
          itemToElement={(item) => (
            <span className="label-option">
              <span
                className="label-option__dot"
                style={{ backgroundColor: `#${item.color}` }}
                aria-hidden="true"
              />
              <span className="label-option__name">{item.name}</span>
              <span className="label-option__count">{item.count}</span>
            </span>
          )}
          selectedItems={labelOptions.filter((option) => filters.labels.includes(option.name))}
          onChange={({ selectedItems }) => update({ labels: selectedItems.map((item) => item.name) })}
          selectionFeedback="top-after-reopen"
        />
      </div>
      <div className="board-toolbar__field">
        <Dropdown<Option>
          id="board-assignee"
          titleText="Assignee"
          hideLabel
          label="Assignee"
          size="md"
          items={assigneeOptions}
          itemToString={(item) => item?.text ?? ''}
          selectedItem={
            assigneeOptions.find((option) => option.value === filters.assignee) ?? assigneeOptions[0]
          }
          onChange={({ selectedItem }) => update({ assignee: selectedItem?.value ?? null })}
        />
      </div>
      <div className="board-toolbar__field">
        <Dropdown<Option>
          id="board-milestone"
          titleText="Milestone"
          hideLabel
          label="Milestone"
          size="md"
          items={milestoneOptions}
          itemToString={(item) => item?.text ?? ''}
          selectedItem={
            milestoneOptions.find((option) => option.value === filters.milestone) ??
            milestoneOptions[0]
          }
          onChange={({ selectedItem }) => update({ milestone: selectedItem?.value ?? null })}
        />
      </div>
      {isFiltering(filters) && (
        <Button
          kind="ghost"
          size="md"
          renderIcon={FilterRemove}
          onClick={() =>
            onFiltersChange({ text: '', labels: [], assignee: null, milestone: null })
          }
        >
          Clear filters
        </Button>
      )}
      <span role="status" className="board-toolbar__connection">
        <Tag size="md" type={CONNECTION_TAG[connection].type}>
          {CONNECTION_TAG[connection].text}
        </Tag>
      </span>
      <Button className="board-toolbar__add" size="md" renderIcon={Add} onClick={onAddBucket}>
        Add bucket
      </Button>
    </div>
  )
}
