import { InlineNotification, Modal } from '@carbon/react'
import { useState } from 'react'
import type { ClaimView } from '../domain/api'
import { ageText, statusLabel } from '../domain/activity'
import { holderName, releaseFailure } from './runDisplay'

interface ReleaseClaimModalProps {
  issue: number
  claim: ClaimView
  /** Epoch milliseconds, for the claim's age. */
  now: number
  /** Releases the claim of `runId`; rejects with the server's error after refreshing the issue. */
  onRelease: (issue: number, runId: string) => Promise<void>
  onClose: () => void
}

export function ReleaseClaimModal({ issue, claim, now, onRelease, onClose }: ReleaseClaimModalProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function release() {
    setBusy(true)
    setError(null)
    try {
      await onRelease(issue, claim.runId)
      onClose()
    } catch (failure) {
      setError(releaseFailure(failure))
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      danger
      size="xs"
      modalHeading={`Release the claim on #${issue}?`}
      primaryButtonText="Release"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={busy}
      loadingStatus={busy ? 'active' : 'inactive'}
      loadingDescription="Releasing the claim…"
      onRequestSubmit={() => void release()}
      onRequestClose={onClose}
    >
      <p>
        {holderName(claim.holder)} holds this card for run {claim.runId} ({statusLabel(claim.status)} for{' '}
        {ageText(claim.since, now)}). Releasing it lets another run start on this issue. If run {claim.runId}{' '}
        continues after another run has claimed the issue, it is refused and stops.
      </p>
      {error && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Not released."
          subtitle={error}
        />
      )}
    </Modal>
  )
}
