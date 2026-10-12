import { InlineNotification, Toggle, ToggleSkeleton } from '@carbon/react'
import { Fragment } from 'react'
import { GITHUB_WRITE_KINDS, type GithubWriteKind } from '../../domain/api'
import { useServerSettings, useUpdateServerSettings } from '../../hooks/useServerSettings'
import './auth.scss'

/** The switch and its explanation for each kind of GitHub write. */
const WRITE_KIND_TEXT: Record<GithubWriteKind, { label: string; description: string }> = {
  createIssues: {
    label: 'Create issues on GitHub',
    description:
      'When this is on, everyone who can sign in to this server can create issues from their ' +
      'boards. Urutau sends only a title and a description; buckets never add labels.',
  },
  editIssues: {
    label: 'Edit, close and reopen issues on GitHub',
    description:
      'When this is on, everyone who can sign in to this server can edit, close and reopen ' +
      'issues from the issue details. Urutau sends only a title, a description and the open or ' +
      'closed state. Before changing an issue, Urutau checks it on GitHub and refuses the change ' +
      'if the issue changed on GitHub since it was loaded.',
  },
}

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
          GITHUB_WRITE_KINDS.map((kind) => <ToggleSkeleton key={kind} />)
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
            {GITHUB_WRITE_KINDS.map((kind) => (
              <Fragment key={kind}>
                <Toggle
                  id={`github-writes-${kind}`}
                  labelText={WRITE_KIND_TEXT[kind].label}
                  labelA="Off"
                  labelB="On"
                  toggled={settings.githubWrites[kind]}
                  disabled={update.isPending || settings.error !== null}
                  onToggle={(checked) =>
                    void update.update({ githubWrites: { [kind]: checked } }).catch(() => undefined)
                  }
                />
                <p className="users__lead">{WRITE_KIND_TEXT[kind].description}</p>
              </Fragment>
            ))}
            <p className="users__lead">
              Each change is made with that person's own GitHub access: the token they pasted in
              Settings, or their Keycloak GitHub link. Each kind of write has its own switch, and a
              kind of write that Urutau adds later starts off.
            </p>
            <p className="users__lead">
              For people who paste a token, these settings only hide the create and edit actions in
              Urutau. Their token works with GitHub directly, so GitHub's permissions on the token
              decide what it can do.
            </p>
          </>
        )}
      </section>
    </div>
  )
}
