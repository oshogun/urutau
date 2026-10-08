import { Button, InlineNotification, Modal, Tag } from '@carbon/react'
import { useState } from 'react'
import type { CardActivity, ClaimView } from '../domain/api'
import { claimIsLive } from '../domain/activity'
import { CLAIM_TAG_TYPE, claimText, claimTone, holderName, releaseFailure } from './runDisplay'

interface ClaimsModalProps {
  repoFullName: string
  cards: ReadonlyMap<number, CardActivity>
  humanWaitLimit: number | null
  now: number
  /** Absent for anyone who cannot release a claim. */
  onRelease?: (issue: number, runId: string) => Promise<void>
  onClose: () => void
}

/** Every live claim of the repository, including those whose issue has no card on the board. */
export function ClaimsModal({
  repoFullName,
  cards,
  humanWaitLimit,
  now,
  onRelease,
  onClose,
}: ClaimsModalProps) {
  const claims = [...cards.values()]
    .filter(
      (card): card is CardActivity & { claim: ClaimView } =>
        card.claim !== null && claimIsLive(card.claim, now),
    )
    .sort((a, b) => a.issue - b.issue)
  const [confirming, setConfirming] = useState<number | null>(null)
  const [releasing, setReleasing] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function release(issue: number, runId: string) {
    if (!onRelease) return
    if (confirming !== issue) {
      setConfirming(issue)
      return
    }
    setReleasing(issue)
    setError(null)
    try {
      await onRelease(issue, runId)
    } catch (failure) {
      setError(releaseFailure(failure))
    } finally {
      setReleasing(null)
      setConfirming(null)
    }
  }

  return (
    <Modal
      open
      passiveModal
      size="md"
      modalHeading={`Claims on ${repoFullName}`}
      closeButtonLabel="Close"
      onRequestClose={onClose}
    >
      {error && (
        <InlineNotification
          kind="warning"
          lowContrast
          title="Not released."
          subtitle={error}
          onClose={() => {
            setError(null)
            return false
          }}
        />
      )}
      {claims.length === 0 ? (
        <p className="claims-list__empty">No issue is claimed right now.</p>
      ) : (
        <ul className="claims-list">
          {claims.map(({ issue, claim }) => (
            <li key={issue} className="claims-list__row">
              <span className="claims-list__issue">#{issue}</span>
              <Tag size="sm" type={CLAIM_TAG_TYPE[claimTone(claim, humanWaitLimit, now)]}>
                {claimText(claim, now)}
                {claimTone(claim, humanWaitLimit, now) === 'over-limit' && (
                  <span className="cds--visually-hidden">
                    , waiting longer than {humanWaitLimit} {humanWaitLimit === 1 ? 'hour' : 'hours'}
                  </span>
                )}
              </Tag>
              <span className="claims-list__holder">
                {holderName(claim.holder)} · run {claim.runId}
              </span>
              {onRelease && (
                <Button
                  size="sm"
                  kind="danger--ghost"
                  disabled={releasing !== null}
                  aria-label={
                    confirming === issue
                      ? `Click again to release the claim on #${issue}`
                      : `Release the claim on #${issue}`
                  }
                  onClick={() => void release(issue, claim.runId)}
                >
                  {confirming === issue ? 'Click again to release' : 'Release'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
