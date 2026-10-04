import { Checkbox, FilterableMultiSelect, Modal, NumberInput, Stack, TextInput } from '@carbon/react'
import { useState } from 'react'
import { newBucketId } from '../domain/board'
import type { Bucket, Label } from '../domain/types'
import { isImeEnter } from './imeEnter'

interface BucketEditorModalProps {
  /** The bucket to edit, or `null` to create one. */
  bucket: Bucket | null
  labels: Label[]
  onSave: (bucket: Bucket) => void
  onClose: () => void
}

export function BucketEditorModal({ bucket, labels, onSave, onClose }: BucketEditorModalProps) {
  const [title, setTitle] = useState(bucket?.title ?? '')
  const [wipLimit, setWipLimit] = useState<number | ''>(bucket?.wipLimit ?? '')
  const [labelRules, setLabelRules] = useState<string[]>(bucket?.labelRules ?? [])
  const [collectsClosed, setCollectsClosed] = useState(bucket?.collectsClosed ?? false)
  const [touched, setTouched] = useState(false)

  const titleInvalid = touched && title.trim() === ''
  const wipInvalid = wipLimit !== '' && (!Number.isInteger(wipLimit) || wipLimit < 1)

  function submit() {
    setTouched(true)
    if (title.trim() === '' || wipInvalid) return
    onSave({
      id: bucket?.id ?? newBucketId(),
      title: title.trim(),
      wipLimit: wipLimit === '' ? null : wipLimit,
      labelRules,
      collectsClosed,
    })
  }

  return (
    <Modal
      open
      size="sm"
      modalHeading={bucket ? `Edit “${bucket.title}”` : 'Add bucket'}
      primaryButtonText={bucket ? 'Save' : 'Add bucket'}
      secondaryButtonText="Cancel"
      onRequestSubmit={submit}
      onRequestClose={onClose}
      shouldSubmitOnEnter
      selectorsFloatingMenus={['.cds--list-box__menu']}
    >
      {/* The modal submits on any Enter keydown that reaches it, so the IME's Enter is stopped here. */}
      <div onKeyDown={(event) => isImeEnter(event) && event.stopPropagation()}>
        <Stack gap={6}>
          <TextInput
            id="bucket-title"
            labelText="Name"
            placeholder="e.g. Ready for QA"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => setTouched(true)}
            invalid={titleInvalid}
            invalidText="Give the bucket a name."
            maxLength={60}
            data-modal-primary-focus
          />
          <NumberInput
            id="bucket-wip"
            label="Work-in-progress limit (optional)"
            helperText="The bucket is highlighted when it holds more open issues than this."
            allowEmpty
            min={1}
            step={1}
            value={wipLimit}
            onChange={(_event, { value }) =>
              setWipLimit(value === '' || value === undefined ? '' : Number(value))
            }
            invalid={wipInvalid}
            invalidText="Use a whole number of 1 or more, or leave it empty."
          />
          <FilterableMultiSelect<Label>
            id="bucket-label-rules"
            titleText="Route issues by label"
            helperText="Open issues with any of these labels start in this bucket until you move them. If several buckets match, the rightmost one wins."
            placeholder="Choose labels"
            items={labels}
            itemToString={(item) => item?.name ?? ''}
            selectedItems={labels.filter((label) => labelRules.includes(label.name))}
            onChange={({ selectedItems }) => setLabelRules(selectedItems.map((label) => label.name))}
            selectionFeedback="top-after-reopen"
            autoAlign
          />
          <Checkbox
            id="bucket-collects-closed"
            labelText="Collect closed issues here"
            helperText="Closed issues always appear in this bucket. Only one bucket can do this, and without one closed issues are hidden."
            checked={collectsClosed}
            onChange={(_event, { checked }) => setCollectsClosed(checked)}
          />
        </Stack>
      </div>
    </Modal>
  )
}
