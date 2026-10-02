import { Download } from '@carbon/icons-react'
import { ActionableNotification, Button, InlineNotification } from '@carbon/react'
import { useState } from 'react'
import { useV1Import } from '../hooks/useV1Import'
import { downloadJson } from './downloadJson'

/** Offers to move the boards this browser kept before the server existed, and reports the result. */
export function V1ImportPrompt() {
  const { pending, busy, error, result, importNow, decline, notNow, copyFor } = useV1Import()
  const [resultClosed, setResultClosed] = useState(false)

  if (result && !resultClosed) {
    const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
    return (
      <div className="connect__import">
        <InlineNotification
          kind="success"
          lowContrast
          title={`Imported ${count(result.imported.length, 'board')} from this browser.`}
          subtitle={
            result.invalid.length > 0
              ? `${count(result.invalid.length, 'saved board')} could not be read and was skipped.`
              : undefined
          }
          onClose={() => {
            setResultClosed(true)
            return false
          }}
        />
        {result.skipped.map((key) => (
          <div key={key} className="connect__import-skipped">
            <span>{key} is already on the server, so it was not replaced.</span>
            <Button
              kind="ghost"
              size="sm"
              renderIcon={Download}
              onClick={() => {
                const file = copyFor(key)
                if (file) downloadJson(`urutau-${key.replace('/', '-')}.json`, file)
              }}
            >
              Download my copy
            </Button>
          </div>
        ))}
      </div>
    )
  }

  if (!pending) return null

  return (
    <div className="connect__import">
      <ActionableNotification
        kind="info"
        lowContrast
        inline
        title="This browser has boards from before the server."
        subtitle="Import them so everyone on this server can see them. Boards already on the server are not replaced."
        actionButtonLabel={busy ? 'Importing…' : 'Import'}
        onActionButtonClick={() => {
          if (!busy) void importNow()
        }}
        onClose={() => {
          notNow()
          return false
        }}
        closeOnEscape={false}
        aria-label="Not now"
      >
        <Button kind="ghost" size="sm" onClick={decline}>
          Don't ask again
        </Button>
      </ActionableNotification>
      {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Import failed." subtitle={error} />}
    </div>
  )
}
