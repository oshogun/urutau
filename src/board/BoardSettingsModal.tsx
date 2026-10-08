import { Download, Reset, Upload } from '@carbon/icons-react'
import { Button, Dropdown, InlineNotification, Modal, NumberInput, Stack } from '@carbon/react'
import { useRef, useState, type ChangeEvent } from 'react'
import { boardFromExport, toBoardExport } from '../domain/board'
import { HUMAN_WAIT_LIMIT_MAX } from '../domain/estimates'
import type { BoardConfig } from '../domain/types'
import { downloadJson } from './downloadJson'

const WINDOWS = [
  { days: 0, text: "Don't show closed issues" },
  { days: 7, text: 'Closed in the last 7 days' },
  { days: 14, text: 'Closed in the last 14 days' },
  { days: 30, text: 'Closed in the last 30 days' },
  { days: 90, text: 'Closed in the last 90 days' },
]

/** The hours field as typed: empty means no limit; otherwise a whole number from 1 to 720. */
function parseWaitHours(text: string): { valid: boolean; value: number | null } {
  const trimmed = text.trim()
  if (trimmed === '') return { valid: true, value: null }
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
  return value >= 1 && value <= HUMAN_WAIT_LIMIT_MAX ? { valid: true, value } : { valid: false, value: null }
}

interface BoardSettingsModalProps {
  repoName: string
  config: BoardConfig
  onSave: (config: BoardConfig) => void
  onReset: () => void
  onClose: () => void
}

export function BoardSettingsModal({
  repoName,
  config,
  onSave,
  onReset,
  onClose,
}: BoardSettingsModalProps) {
  const [closedWindowDays, setClosedWindowDays] = useState(config.closedWindowDays)
  const [waitHours, setWaitHours] = useState(config.humanWaitLimit == null ? '' : String(config.humanWaitLimit))
  const wait = parseWaitHours(waitHours)
  const [importError, setImportError] = useState<string | null>(null)
  const [confirmingReset, setConfirmingReset] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const windows = WINDOWS.some((option) => option.days === config.closedWindowDays)
    ? WINDOWS
    : [...WINDOWS, { days: config.closedWindowDays, text: `Closed in the last ${config.closedWindowDays} days` }]

  function exportBoard() {
    const file = toBoardExport(config, repoName)
    downloadJson(`urutau-${repoName.replace('/', '-')}.json`, file)
  }

  async function importBoard(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    let board = null
    try {
      board = boardFromExport(JSON.parse(await file.text()), repoName)
    } catch {
      // Not JSON; reported below.
    }
    if (!board) {
      setImportError('That file is not an Urutau board export.')
      return
    }
    onSave(board)
    onClose()
  }

  return (
    <Modal
      open
      size="sm"
      modalHeading="Board settings"
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!wait.valid}
      onRequestSubmit={() => {
        if (!wait.valid) return
        onSave({ ...config, closedWindowDays, humanWaitLimit: wait.value })
        onClose()
      }}
      onRequestClose={onClose}
      selectorsFloatingMenus={['.cds--list-box__menu']}
    >
      <Stack gap={7}>
        <Dropdown
          id="board-closed-window"
          titleText="Closed issues"
          helperText="Recently closed issues are shown in the bucket that collects closed issues. Longer windows use more API requests."
          label="Closed issues"
          items={windows}
          itemToString={(item) => item?.text ?? ''}
          selectedItem={windows.find((option) => option.days === closedWindowDays) ?? windows[0]}
          onChange={({ selectedItem }) => setClosedWindowDays(selectedItem?.days ?? 0)}
        />

        <NumberInput
          id="board-human-wait-limit"
          label="Hours a card may wait on a human (optional)"
          helperText="A card that has waited on a person for longer than this many hours turns red. Leave it empty for no limit."
          allowEmpty
          min={1}
          max={HUMAN_WAIT_LIMIT_MAX}
          step={1}
          value={waitHours}
          invalid={!wait.valid}
          invalidText={`Use a whole number of hours from 1 to ${HUMAN_WAIT_LIMIT_MAX}.`}
          onChange={(_event, state) => setWaitHours(String(state.value ?? ''))}
        />

        <section className="board-settings__section" aria-labelledby="board-settings-transfer">
          <h3 id="board-settings-transfer" className="board-settings__heading">
            Share this board
          </h3>
          <p className="board-settings__text">
            This board is stored on the Urutau server and shared with everyone who has an account.
            Export its buckets, rules and card positions to keep a copy or reuse them on another
            server. Importing a board file replaces this board for everyone. A board exported from
            another repository brings its buckets and rules, but not card positions.
          </p>
          <div className="board-settings__actions">
            <Button kind="tertiary" size="sm" renderIcon={Download} onClick={exportBoard}>
              Export board
            </Button>
            <Button
              kind="tertiary"
              size="sm"
              renderIcon={Upload}
              onClick={() => fileInput.current?.click()}
            >
              Import board
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(event) => void importBoard(event)}
            />
          </div>
          {importError && (
            <InlineNotification
              kind="error"
              lowContrast
              title="Import failed"
              subtitle={importError}
              onClose={() => setImportError(null)}
            />
          )}
        </section>

        <section className="board-settings__section" aria-labelledby="board-settings-reset">
          <h3 id="board-settings-reset" className="board-settings__heading">
            Start over
          </h3>
          <p className="board-settings__text">
            Restore the default buckets and forget every card position for this repository. Estimates are kept.
          </p>
          <div className="board-settings__actions">
            <Button
              kind={confirmingReset ? 'danger' : 'danger--tertiary'}
              size="sm"
              renderIcon={Reset}
              onClick={() => {
                if (!confirmingReset) {
                  setConfirmingReset(true)
                  return
                }
                onReset()
                onClose()
              }}
            >
              {confirmingReset ? 'Click again to reset' : 'Reset board'}
            </Button>
          </div>
        </section>
      </Stack>
    </Modal>
  )
}
