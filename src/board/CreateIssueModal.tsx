import { ActionableNotification, Modal, Stack, TextArea, TextInput } from '@carbon/react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { KeycloakButton } from '../components/auth/KeycloakButton'
import { NEW_ISSUE_BODY_MAX, NEW_ISSUE_TITLE_MAX } from '../domain/api'
import type { Bucket, Issue } from '../domain/types'
import { CreateIssueError } from '../github/createIssue'
import type { CreateIssueInput } from '../hooks/useCreateIssue'
import { useSession } from '../state/session'
import { useSettings } from '../state/settings'
import { isImeEnter } from './imeEnter'

export interface IssueDraft {
  title: string
  body: string
}

interface CreateIssueModalProps {
  fullName: string
  bucket: Bucket
  draft: IssueDraft
  onDraftChange: (draft: IssueDraft) => void
  create: (input: CreateIssueInput) => Promise<Issue>
  onCreated: (issue: Issue) => void
  onClose: () => void
  onOpenSettings: () => void
  onRefresh: () => void
  launcherButtonRef: RefObject<HTMLButtonElement | null>
}

/** Counts Unicode code points, as GitHub and the server do; `length` counts UTF-16 units. */
const length = (text: string) => [...text].length

const NO_TOKEN_TEXT =
  'Creating issues needs a GitHub personal access token with Issues read and write permission. Add one in Settings.'

const NOTIFICATION_BY_OUTCOME = {
  'not-created': { kind: 'error', title: "Couldn't create the issue." },
  unknown: { kind: 'warning', title: 'The issue may have been created.' },
  created: { kind: 'info', title: 'The issue was created.' },
} as const

/** Asks for a title and a description, then creates the issue through `create`. */
export function CreateIssueModal({
  fullName,
  bucket,
  draft,
  onDraftChange,
  create,
  onCreated,
  onClose,
  onOpenSettings,
  onRefresh,
  launcherButtonRef,
}: CreateIssueModalProps) {
  const [sending, setSending] = useState(false)
  const [failure, setFailure] = useState<CreateIssueError | null>(null)
  const inFlight = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const refocusTitle = useRef(false)
  const serverPath = useSession((state) => state.session?.githubAccess.mode === 'server')
  const token = useSettings((state) => state.token)
  const noToken = !serverPath && token.trim() === ''

  const titleTooLong = length(draft.title.trim()) > NEW_ISSUE_TITLE_MAX
  const bodyTooLong = length(draft.body) > NEW_ISSUE_BODY_MAX
  const finished = failure?.kind === 'created-unreadable' || failure?.kind === 'writes-off'
  const canSubmit =
    !noToken && !finished && draft.title.trim() !== '' && !titleTooLong && !bodyTooLong

  async function submit() {
    if (inFlight.current || !canSubmit) return
    inFlight.current = true
    const stop = new AbortController()
    controller.current = stop
    // The primary button is about to be disabled; the title input is only read-only while
    // sending, so focus waits there.
    titleRef.current?.focus()
    setSending(true)
    setFailure(null)
    try {
      const issue = await create({
        fullName,
        bucketId: bucket.id,
        fields: { title: draft.title, body: draft.body },
        signal: stop.signal,
      })
      onCreated(issue)
    } catch (error) {
      refocusTitle.current = true
      setFailure(
        error instanceof CreateIssueError
          ? error
          : new CreateIssueError({
              kind: 'unknown',
              message: error instanceof Error ? error.message : 'Something went wrong.',
            }),
      )
    } finally {
      inFlight.current = false
      controller.current = null
      setSending(false)
    }
  }

  // After a failure, focus returns to the title input: the primary button may stay disabled, and
  // focus must not be left on it.
  useEffect(() => {
    if (sending || !refocusTitle.current) return
    refocusTitle.current = false
    titleRef.current?.focus()
  }, [sending, failure])

  // While a request is out, Esc and the close button stop waiting for it; the dialog stays open
  // to say what is known. Otherwise they close the dialog.
  function requestClose() {
    if (controller.current) controller.current.abort()
    else onClose()
  }

  const notice = failure ? NOTIFICATION_BY_OUTCOME[failure.outcome] : null

  return (
    <Modal
      open
      size="md"
      modalHeading="Create issue"
      modalLabel={`${fullName} · ${bucket.title}`}
      primaryButtonText="Create issue"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!canSubmit}
      loadingStatus={sending ? 'active' : 'inactive'}
      loadingDescription="Creating issue…"
      preventCloseOnClickOutside
      launcherButtonRef={launcherButtonRef}
      onRequestSubmit={() => void submit()}
      onRequestClose={requestClose}
    >
      <Stack gap={6}>
        <p>
          Creates an issue in {fullName} on GitHub, as you. The card goes to {bucket.title}; no
          labels are added.
        </p>
        {noToken && (
          <ActionableNotification
            inline
            lowContrast
            hideCloseButton
            hasFocus={false}
            closeOnEscape={false}
            kind="info"
            role="status"
            title="A token with write access is needed."
            subtitle={NO_TOKEN_TEXT}
            actionButtonLabel="Open settings"
            onActionButtonClick={onOpenSettings}
          />
        )}
        {failure && notice && (
          <ActionableNotification
            inline
            lowContrast
            hideCloseButton
            hasFocus={false}
            closeOnEscape={false}
            role="alert"
            kind={notice.kind}
            title={notice.title}
            subtitle={failure.message}
            actionButtonLabel={
              failure.action === 'open-settings'
                ? 'Open settings'
                : failure.action === 'refresh'
                  ? 'Refresh board'
                  : undefined
            }
            onActionButtonClick={failure.action === 'open-settings' ? onOpenSettings : onRefresh}
          >
            {failure.action === 'sign-in-keycloak' && (
              <KeycloakButton kind="secondary" size="sm">
                Sign in with Keycloak again
              </KeycloakButton>
            )}
          </ActionableNotification>
        )}
        <TextInput
          id="create-issue-title"
          ref={titleRef}
          labelText="Title"
          value={draft.title}
          readOnly={sending}
          invalid={titleTooLong}
          invalidText={`Use at most ${NEW_ISSUE_TITLE_MAX} characters.`}
          onChange={(event) => onDraftChange({ ...draft, title: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !isImeEnter(event)) {
              event.preventDefault()
              void submit()
            }
          }}
          data-modal-primary-focus
        />
        <TextArea
          id="create-issue-body"
          labelText="Description (optional)"
          helperText="Markdown. GitHub formats it; here it is plain text."
          rows={8}
          value={draft.body}
          readOnly={sending}
          invalid={bodyTooLong}
          invalidText={`Use at most ${NEW_ISSUE_BODY_MAX.toLocaleString('en-US')} characters.`}
          onChange={(event) => onDraftChange({ ...draft, body: event.target.value })}
        />
      </Stack>
    </Modal>
  )
}
