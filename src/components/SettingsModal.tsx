import { Modal, PasswordInput, RadioButton, RadioButtonGroup, Stack } from '@carbon/react'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { SNAPSHOT_QUERY_ROOT } from '../hooks/useRepoSnapshot'
import { useSession } from '../state/session'
import { useSettings, type ThemePreference } from '../state/settings'

interface SettingsModalProps {
  onClose: () => void
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const queryClient = useQueryClient()
  const token = useSettings((state) => state.token)
  const browserToken = useSession((state) => state.session?.githubAccess.mode !== 'server')
  const theme = useSettings((state) => state.theme)
  const setToken = useSettings((state) => state.setToken)
  const setTheme = useSettings((state) => state.setTheme)

  const [tokenDraft, setTokenDraft] = useState(token)
  const [themeDraft, setThemeDraft] = useState(theme)

  function save() {
    if (browserToken && tokenDraft.trim() !== token) {
      setToken(tokenDraft)
      // Reload with the new credentials (and drop errors caused by the old ones).
      void queryClient.resetQueries({ queryKey: [SNAPSHOT_QUERY_ROOT] })
    }
    setTheme(themeDraft)
    onClose()
  }

  return (
    <Modal
      open
      size="sm"
      modalHeading="Settings"
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      onRequestSubmit={save}
      onRequestClose={onClose}
    >
      <Stack gap={7}>
        {browserToken ? (
          <PasswordInput
            id="settings-token"
            labelText="GitHub personal access token"
            helperText="Optional for public repositories. Use a fine-grained token with read-only access to Issues (and Metadata). It is stored in this browser's local storage and only sent to api.github.com."
            value={tokenDraft}
            onChange={(event) => setTokenDraft(event.target.value)}
            autoComplete="off"
            data-modal-primary-focus
          />
        ) : (
          <p className="settings-note">GitHub is read through your Keycloak link.</p>
        )}
        <RadioButtonGroup
          legendText="Theme"
          name="settings-theme"
          valueSelected={themeDraft}
          onChange={(value) => setThemeDraft(value as ThemePreference)}
        >
          <RadioButton id="settings-theme-system" labelText="Match system" value="system" />
          <RadioButton id="settings-theme-light" labelText="Light" value="light" />
          <RadioButton id="settings-theme-dark" labelText="Dark" value="dark" />
        </RadioButtonGroup>
      </Stack>
    </Modal>
  )
}
