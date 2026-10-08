import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack, Button } from '@carbon/react'
import { useState } from 'react'
import type { SetEstimateRequest } from '../domain/api'
import type { Estimate, EstimateConfidence, EstimateSize } from '../domain/types'

interface EstimateModalProps {
  issue: number
  /** The stored estimate, if there is one. */
  estimate: Estimate | null
  /** Saves the estimate, or removes it with null. Rejects with the server's error. */
  onSave: (issue: number, request: SetEstimateRequest | null) => Promise<void>
  onClose: () => void
}

const SIZES: ReadonlyArray<{ value: EstimateSize; label: string }> = [
  { value: 'S', label: 'S · Small' },
  { value: 'M', label: 'M · Medium' },
  { value: 'L', label: 'L · Large' },
]

const CONFIDENCES: ReadonlyArray<{ value: EstimateConfidence; label: string }> = [
  { value: 'sure', label: 'Sure' },
  { value: 'unsure', label: 'Unsure' },
  { value: 'no-idea', label: 'No idea' },
]

export function EstimateModal({ issue, estimate, onSave, onClose }: EstimateModalProps) {
  const [size, setSize] = useState<EstimateSize | null>(estimate?.size ?? null)
  const [confidence, setConfidence] = useState<EstimateConfidence>(estimate?.confidence ?? 'sure')
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const noIdea = confidence === 'no-idea'
  const canSave = busy === null && (noIdea || size !== null)

  async function run(kind: 'save' | 'remove', request: SetEstimateRequest | null) {
    setBusy(kind)
    setError(null)
    try {
      await onSave(issue, request)
      onClose()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The estimate could not be saved.')
      setBusy(null)
    }
  }

  return (
    <Modal
      open
      size="xs"
      modalHeading={`Estimate for #${issue}`}
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!canSave}
      loadingStatus={busy === 'save' ? 'active' : 'inactive'}
      loadingDescription="Saving the estimate…"
      onRequestSubmit={() => {
        if (canSave) void run('save', { size: noIdea ? null : size, confidence })
      }}
      onRequestClose={onClose}
    >
      <Stack gap={6}>
        <RadioButtonGroup
          legendText="Size"
          name={`estimate-size-${issue}`}
          valueSelected={noIdea ? undefined : (size ?? undefined)}
          disabled={noIdea}
          onChange={(value) => setSize(value as EstimateSize)}
        >
          {SIZES.map((option) => (
            <RadioButton
              key={option.value}
              id={`estimate-size-${issue}-${option.value}`}
              value={option.value}
              labelText={option.label}
            />
          ))}
        </RadioButtonGroup>
        <RadioButtonGroup
          legendText="How sure are you?"
          name={`estimate-confidence-${issue}`}
          valueSelected={confidence}
          onChange={(value) => setConfidence(value as EstimateConfidence)}
        >
          {CONFIDENCES.map((option) => (
            <RadioButton
              key={option.value}
              id={`estimate-confidence-${issue}-${option.value}`}
              value={option.value}
              labelText={option.label}
            />
          ))}
        </RadioButtonGroup>
        {estimate && (
          <div>
            <Button kind="ghost" size="sm" disabled={busy !== null} onClick={() => void run('remove', null)}>
              Remove estimate
            </Button>
          </div>
        )}
        {error && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Couldn't save the estimate."
            subtitle={error}
          />
        )}
      </Stack>
    </Modal>
  )
}
