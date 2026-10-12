import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack, Button } from '@carbon/react'
import { useState } from 'react'
import { triageRangeSizes, triageRangeText } from '../domain/activity'
import type { SetEstimateRequest } from '../domain/api'
import type { Estimate, EstimateConfidence, EstimateSize, TriageRange } from '../domain/types'

interface EstimateModalProps {
  issue: number
  /** The stored estimate, if there is one. */
  estimate: Estimate | null
  /** Saves the estimate, or removes it with null. Rejects with the server's error. */
  onSave: (issue: number, request: SetEstimateRequest | null) => Promise<void>
  onClose: () => void
  /**
   * An agent's triage range being accepted as the estimate: only its sizes are offered,
   * a one-size range starts on that size, and 'No idea' and Remove are left out.
   */
  range?: TriageRange | null
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

function initialSize(estimate: Estimate | null, rangeSizes: EstimateSize[] | null): EstimateSize | null {
  if (rangeSizes === null) return estimate?.size ?? null
  if (rangeSizes.length === 1) return rangeSizes[0]
  return estimate?.size && rangeSizes.includes(estimate.size) ? estimate.size : null
}

function initialConfidence(estimate: Estimate | null, accepting: boolean): EstimateConfidence {
  const confidence = estimate?.confidence ?? 'sure'
  return accepting && confidence === 'no-idea' ? 'sure' : confidence
}

export function EstimateModal({ issue, estimate, onSave, onClose, range = null }: EstimateModalProps) {
  const rangeSizes = range === null ? null : triageRangeSizes(range)
  const sizes = rangeSizes === null ? SIZES : SIZES.filter((option) => rangeSizes.includes(option.value))
  const confidences =
    range === null ? CONFIDENCES : CONFIDENCES.filter((option) => option.value !== 'no-idea')
  const [size, setSize] = useState<EstimateSize | null>(() => initialSize(estimate, rangeSizes))
  const [confidence, setConfidence] = useState<EstimateConfidence>(() =>
    initialConfidence(estimate, range !== null),
  )
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
        {range !== null && (
          <p className="estimate-modal__range">Agent's triage range: {triageRangeText(range)}</p>
        )}
        <RadioButtonGroup
          legendText="Size"
          name={`estimate-size-${issue}`}
          valueSelected={noIdea ? undefined : (size ?? undefined)}
          disabled={noIdea}
          onChange={(value) => setSize(value as EstimateSize)}
        >
          {sizes.map((option) => (
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
          {confidences.map((option) => (
            <RadioButton
              key={option.value}
              id={`estimate-confidence-${issue}-${option.value}`}
              value={option.value}
              labelText={option.label}
            />
          ))}
        </RadioButtonGroup>
        {estimate && range === null && (
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
