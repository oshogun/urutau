import { InlineNotification, Toggle, ToggleSkeleton } from '@carbon/react'
import { useServerSettings, useUpdateServerSettings } from '../../hooks/useServerSettings'
import './auth.scss'

/** Admin screen: the server-wide switches. */
export function ServerSettingsPage() {
  const settings = useServerSettings()
  const update = useUpdateServerSettings()

  return (
    <div className="users">
      <title>Server settings · Urutau</title>
      <h1 className="users__title">Server settings</h1>

      <section className="server-settings__section" aria-labelledby="server-settings-github-heading">
        <h2 id="server-settings-github-heading" className="users__heading">
          GitHub
        </h2>
        {settings.isLoading ? (
          <ToggleSkeleton />
        ) : (
          <>
            {settings.error && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Could not load the server settings."
                subtitle={settings.error.message}
              />
            )}
            {update.error && (
              <InlineNotification
                role="alert"
                kind="error"
                lowContrast
                hideCloseButton
                title="Could not save the setting."
                subtitle={update.error.message}
              />
            )}
            <Toggle
              id="github-writes"
              labelText="Create and edit issues on GitHub"
              labelA="Off"
              labelB="On"
              toggled={settings.githubWrites}
              disabled={update.isPending || settings.error !== null}
              onToggle={(checked) => void update.update({ githubWrites: checked }).catch(() => undefined)}
            />
            <p className="users__lead">
              When this is on, everyone who can sign in to this server can create issues from their
              boards, and edit, close and reopen issues from the issue details. Each change is made
              with that person's own GitHub access: the token they pasted in Settings, or their
              Keycloak GitHub link. Urutau sends only a title, a description and the open or closed
              state; buckets never add labels. Before changing an issue, Urutau checks it on GitHub
              and refuses the change if the issue changed on GitHub since it was loaded.
            </p>
            <p className="users__lead">
              For people who paste a token, this setting only hides the create and edit actions in
              Urutau. Their token works with GitHub directly, so GitHub's permissions on the token
              decide what it can do.
            </p>
          </>
        )}
      </section>
    </div>
  )
}
