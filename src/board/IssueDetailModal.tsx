import { Chat, CheckmarkOutline, CloseOutline, Edit, Launch, Milestone, Undo } from '@carbon/icons-react'
import {
  ActionableNotification,
  Button,
  InlineLoading,
  Layer,
  Link,
  ListItem,
  Modal,
  Stack,
  Tag,
  TextArea,
  TextInput,
  UnorderedList,
} from '@carbon/react'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { KeycloakButton } from '../components/auth/KeycloakButton'
import { NEW_ISSUE_BODY_MAX, NEW_ISSUE_TITLE_MAX } from '../domain/api'
import {
  conflictingFields,
  describeChanges,
  editFields,
  rebaseDraft,
  startDraft,
  stateActionPending,
  stateFields,
  textareaValue,
  type IssueChange,
  type IssueDraft,
  type IssueStateAction,
  type IssueVersion,
} from '../domain/issueUpdate'
import { labelFor } from '../domain/labels'
import type { Issue, Label, User } from '../domain/types'
import { UpdateIssueError, updateIssueFailures } from '../github/updateIssue'
import type { IssueUpdater } from '../hooks/useUpdateIssue'
import { useSession } from '../state/session'
import { useSettings } from '../state/settings'
import { isImeEnter } from './imeEnter'
import { IssueBody } from './IssueBody'
import { avatarSrc, issueStateTag } from './issueDisplay'
import { LabelTag } from './LabelTag'

export interface IssueDetailModalProps {
  issue: Issue
  repoFullName: string
  labelsByName: ReadonlyMap<string, Label>
  /** `snapshot.fetchedAt`, epoch milliseconds. */
  fetchedAt: number
  /** Board's ref to the details button that opened the modal; passed to Carbon's `Modal`. */
  launcherButtonRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  /** Changes the issue on GitHub; absent or null shows the details read only, as before. */
  onUpdate?: IssueUpdater | null
  /** Opens Settings (closing the dialog); shown as a notice action for token problems. */
  onOpenSettings?: () => void
  /** Refetches the board; shown as a notice action when GitHub may hold a different version. */
  onRefresh?: () => void
}

/** Counts Unicode code points, as GitHub and the server do; `length` counts UTF-16 units. */
const length = (text: string) => [...text].length

const ACTIONS: Record<IssueStateAction, { label: string; pending: string; done: string; apply: string }> = {
  'close-completed': {
    label: 'Close as completed',
    pending: 'Closing the issue on GitHub…',
    done: 'Closed as completed.',
    apply: 'close it as completed',
  },
  'close-not-planned': {
    label: 'Close as not planned',
    pending: 'Closing the issue on GitHub…',
    done: 'Closed as not planned.',
    apply: 'close it as not planned',
  },
  reopen: {
    label: 'Reopen',
    pending: 'Reopening the issue on GitHub…',
    done: 'Reopened.',
    apply: 'reopen it',
  },
}

const FAILURE_BY_OUTCOME = {
  'not-applied': { kind: 'error', title: "Couldn't change the issue." },
  unknown: { kind: 'warning', title: 'The change may have been applied.' },
  applied: { kind: 'info', title: 'The change was saved.' },
} as const

const KEPT_ONLY_WHILE_OPEN = 'Your text is not kept when this dialog closes; copy it first if you need it.'

const stateLong = (version: IssueVersion) => issueStateTag(version.state, version.stateReason).long.toLowerCase()

function changeLine(change: IssueChange, current: IssueVersion): string {
  if (change === 'title') return `The title is now “${current.title}”.`
  if (change === 'body') return 'The description changed.'
  if (change === 'state') return `It is now ${stateLong(current)}.`
  return 'Something else changed, such as a comment, a label, an assignee or the milestone. Your change does not touch those.'
}

/** What the person has already changed, kept while the dialog is open. */
interface Editor {
  /** The version the edit starts from; moves to GitHub's version after a refused save. */
  base: IssueVersion
  draft: IssueDraft
  update: IssueUpdater
  /** True after a refused save, so the primary button reads "Apply again". */
  rebased: boolean
}

type Notice =
  | { kind: 'failure'; error: UpdateIssueError }
  | {
      kind: 'stale'
      changes: IssueChange[]
      current: Issue
      conflicts: Array<'title' | 'body'>
      retry: IssueStateAction | null
    }
  | { kind: 'success'; text: string }

function joinWords(words: string[]): string {
  return words.join(' and ')
}

function DateText({ iso }: { iso: string }) {
  const date = new Date(iso)
  return (
    <time dateTime={iso} title={date.toLocaleString()}>
      {date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
    </time>
  )
}

function Person({ user }: { user: User }) {
  return (
    <span className="issue-detail__person">
      <img src={avatarSrc(user.avatarUrl)} alt="" width={20} height={20} loading="lazy" />
      {user.login}
    </span>
  )
}

/** The version with the later `updatedAt`; `a` when they are equal or a time cannot be read. */
function newerOf(a: Issue, b: Issue | null): Issue {
  return b !== null && b.number === a.number && Date.parse(b.updatedAt) > Date.parse(a.updatedAt) ? b : a
}

export function IssueDetailModal({
  issue: boardIssue,
  repoFullName,
  labelsByName,
  fetchedAt,
  launcherButtonRef,
  onClose,
  onUpdate: currentUpdate = null,
  onOpenSettings,
  onRefresh,
}: IssueDetailModalProps) {
  const [editor, setEditor] = useState<Editor | null>(null)
  const [sending, setSending] = useState<IssueStateAction | 'edit' | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  // The newest version of the issue this dialog has seen: a change's result or GitHub's version
  // in a refusal. The board's copy can be older (a closed issue the snapshot does not hold is
  // passed as it was when the dialog opened), so the dialog shows the newer of the two and starts
  // every change from it.
  const [seen, setSeen] = useState<Issue | null>(null)
  const issue = newerOf(boardIssue, seen)
  const remember = (version: Issue) => setSeen((previous) => newerOf(version, previous))
  const focusTarget = useRef<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const loadingRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const serverPath = useSession((state) => state.session?.githubAccess.mode === 'server')
  const token = useSettings((state) => state.token)

  // Once an action has been started here, the buttons and its notice stay even if the admin turns
  // changes off while the modal is open; the next press then reports the switch as off.
  const [attempted, setAttempted] = useState(false)
  const latestUpdate = useRef(currentUpdate)
  useEffect(() => {
    if (currentUpdate) latestUpdate.current = currentUpdate
  }, [currentUpdate])
  const hasUpdater = currentUpdate !== null || attempted

  const editing = editor !== null
  const canChange = hasUpdater || editing
  const noToken = hasUpdater && !editing && !serverPath && token.trim() === ''
  const start: IssueVersion = issue

  const label = `${repoFullName} #${issue.number}`
  const tag = issueStateTag(issue.state, issue.stateReason)
  const hasFields = issue.labels.length > 0 || issue.assignees.length > 0 || issue.milestone !== null
  const loadedAt = new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  // Moves focus to a button once it exists, after a change of mode or of the issue's state. The
  // move waits one task: Carbon's focus wrap queues its own focus change when the element that
  // had focus leaves the page, and that one must not run after this one.
  useEffect(() => {
    if (focusTarget.current === null) return
    const id = focusTarget.current
    const timer = setTimeout(() => {
      const element = document.getElementById(id)
      if (element && !element.hasAttribute('disabled')) {
        element.focus()
        if (focusTarget.current === id) focusTarget.current = null
      } else if (!element) {
        // The button is gone, so focus goes to the dialog's content instead of leaving the dialog.
        document.querySelector<HTMLElement>('.cds--modal-content')?.focus()
        if (focusTarget.current === id) focusTarget.current = null
      }
    })
    return () => clearTimeout(timer)
  })

  // When the admin turns changes off while focus is on a button that then unmounts and nothing was
  // pressed, focus would fall to the page behind the dialog; move it into the dialog's content.
  const hadChange = useRef(canChange)
  useEffect(() => {
    const lost = hadChange.current && !canChange
    hadChange.current = canChange
    if (!lost) return
    const timer = setTimeout(() => {
      const active = document.activeElement
      if (!active || active === document.body || !active.closest('[role="dialog"]')) {
        document.querySelector<HTMLElement>('.cds--modal-content')?.focus()
      }
    })
    return () => clearTimeout(timer)
  }, [canChange])

  useEffect(() => {
    if (!editing) return
    const timer = setTimeout(() => titleRef.current?.focus())
    return () => clearTimeout(timer)
  }, [editing])

  function fail(error: unknown): UpdateIssueError {
    return error instanceof UpdateIssueError
      ? error
      : new UpdateIssueError({
          kind: 'unreachable',
          message: error instanceof Error ? error.message : 'Something went wrong.',
        })
  }

  async function changeState(action: IssueStateAction, expectedUpdatedAt: string) {
    const onUpdate = currentUpdate ?? latestUpdate.current
    if (!onUpdate || !hasUpdater || controller.current) return
    const stop = new AbortController()
    controller.current = stop
    setAttempted(true)
    // The pressed button is about to be disabled; focus must not be lost with it.
    loadingRef.current?.focus()
    setSending(action)
    setNotice(null)
    try {
      const changed = await onUpdate({
        fullName: repoFullName,
        number: issue.number,
        expectedUpdatedAt,
        fields: stateFields(action),
        signal: stop.signal,
      })
      remember(changed)
      setNotice({ kind: 'success', text: ACTIONS[action].done })
      focusTarget.current = action === 'reopen' ? 'issue-action-close-completed' : 'issue-action-reopen'
    } catch (error) {
      const failure = fail(error)
      focusTarget.current = `issue-action-${action}`
      if (failure.kind === 'stale' && failure.current) {
        const { current } = failure
        remember(current)
        setNotice({
          kind: 'stale',
          changes: describeChanges(start, current),
          current,
          conflicts: [],
          retry: stateActionPending(action, current) ? action : null,
        })
      } else {
        setNotice({ kind: 'failure', error: failure })
      }
    } finally {
      controller.current = null
      setSending(null)
    }
  }

  function startEdit() {
    const onUpdate = currentUpdate ?? latestUpdate.current
    if (!onUpdate || !hasUpdater) return
    setAttempted(true)
    setEditor({
      base: start,
      draft: startDraft(start),
      update: onUpdate,
      rebased: false,
    })
    setNotice(null)
  }

  function leaveEdit() {
    setEditor(null)
    setNotice(null)
    focusTarget.current = 'issue-edit-button'
  }

  const draftFields = editor ? editFields(editor.base, editor.draft) : {}
  const titleBlank = editor !== null && editor.draft.title.trim() === ''
  const titleTooLong = editor !== null && length(editor.draft.title.trim()) > NEW_ISSUE_TITLE_MAX
  const bodyTooLong =
    editor !== null && draftFields.body !== undefined && length(editor.draft.body) > NEW_ISSUE_BODY_MAX
  const canSave =
    editor !== null &&
    sending === null &&
    Object.keys(draftFields).length > 0 &&
    !titleBlank &&
    !titleTooLong &&
    !bodyTooLong

  async function save() {
    if (!editor || !canSave || controller.current) return
    const { base, draft, update } = editor
    const fields = draftFields
    const stop = new AbortController()
    controller.current = stop
    setSending('edit')
    setNotice(null)
    try {
      const changed = await update({
        fullName: repoFullName,
        number: issue.number,
        expectedUpdatedAt: base.updatedAt,
        fields,
        signal: stop.signal,
      })
      remember(changed)
      setEditor(null)
      setNotice({
        kind: 'success',
        text: `${
          fields.title !== undefined && fields.body !== undefined
            ? 'Title and description'
            : fields.title !== undefined
              ? 'Title'
              : 'Description'
        } changed.`,
      })
      focusTarget.current = 'issue-edit-button'
    } catch (error) {
      const failure = fail(error)
      if (failure.kind === 'stale' && failure.current) {
        const { current } = failure
        remember(current)
        setEditor({
          base: current,
          draft: rebaseDraft(base, draft, current),
          update,
          rebased: true,
        })
        setNotice({
          kind: 'stale',
          changes: describeChanges(base, current),
          current,
          conflicts: conflictingFields(base, draft, current),
          retry: null,
        })
      } else {
        setNotice({ kind: 'failure', error: failure })
      }
    } finally {
      controller.current = null
      setSending(null)
    }
  }

  // While a request is out, Escape and the close button stop waiting for it and the dialog stays
  // to say what is known. Otherwise they leave edit mode, discarding the draft, or close the dialog.
  // Carbon registers its Escape listener once, with the first onRequestClose it sees, so the
  // handler passed to it reads the latest one through a ref.
  const requestClose = useRef(() => {})
  useEffect(() => {
    requestClose.current = () => {
      if (controller.current) controller.current.abort()
      else if (editing) leaveEdit()
      else onClose()
    }
  })

  function renderNotice() {
    if (!notice) return null
    const common = {
      inline: true,
      lowContrast: true,
      hasFocus: false,
      closeOnEscape: false,
    } as const
    if (notice.kind === 'success') {
      return (
        <ActionableNotification
          {...common}
          role="status"
          kind="success"
          title="Saved to GitHub."
          subtitle={notice.text}
          onClose={() => {
            focusTarget.current = 'issue-edit-button'
            setNotice(null)
            return true
          }}
        />
      )
    }
    if (notice.kind === 'stale') {
      const { current, changes, conflicts, retry } = notice
      const mine = Object.keys(draftFields).length > 0
      const sentence = editor
        ? mine
          ? `Your changes are kept. Fields you did not change now show GitHub's text.${
              conflicts.length > 0
                ? ` You and GitHub both changed the ${joinWords(
                    conflicts.map((field) => (field === 'body' ? 'description' : 'title')),
                  )}; Apply again replaces GitHub's with yours.`
                : ''
            }`
          : 'GitHub already has your changes.'
        : retry
          ? `Apply again to ${ACTIONS[retry].apply}.`
          : `It is already ${stateLong(current)} on GitHub.`
      return (
        <ActionableNotification
          {...common}
          hideCloseButton
          role="alert"
          kind={!editor && !retry ? 'info' : 'warning'}
          title={`This issue changed on GitHub since ${editor ? 'you started editing' : 'it was loaded'}. Nothing was sent.`}
          actionButtonLabel={!editor && retry ? 'Apply again' : undefined}
          onActionButtonClick={retry ? () => void changeState(retry, current.updatedAt) : undefined}
        >
          <UnorderedList>
            {changes.map((change) => (
              <ListItem key={change}>{changeLine(change, current)}</ListItem>
            ))}
          </UnorderedList>
          <p className="issue-detail__notice-text">{sentence}</p>
        </ActionableNotification>
      )
    }
    const { error } = notice
    const style = FAILURE_BY_OUTCOME[error.outcome]
    const leaves = error.action === 'open-settings' || error.action === 'sign-in-keycloak'
    const warnAboutDraft = editing && leaves && Object.keys(draftFields).length > 0
    return (
      <ActionableNotification
        {...common}
        hideCloseButton
        role="alert"
        kind={style.kind}
        title={style.title}
        subtitle={warnAboutDraft ? `${error.message} ${KEPT_ONLY_WHILE_OPEN}` : error.message}
        actionButtonLabel={
          error.action === 'open-settings' ? 'Open settings' : error.action === 'refresh' ? 'Refresh board' : undefined
        }
        onActionButtonClick={error.action === 'open-settings' ? onOpenSettings : onRefresh}
      >
        {error.action === 'sign-in-keycloak' && (
          <KeycloakButton kind="secondary" size="sm">
            Sign in with Keycloak again
          </KeycloakButton>
        )}
      </ActionableNotification>
    )
  }

  const noticeBlock = renderNotice()
  const busy = sending !== null

  return (
    <Modal
      open
      passiveModal={!editing}
      size="lg"
      hasScrollingContent
      modalLabel={label}
      aria-label={label}
      modalHeading={issue.title}
      closeButtonLabel="Close"
      selectorPrimaryFocus=".cds--modal-content"
      launcherButtonRef={launcherButtonRef}
      onRequestClose={() => requestClose.current()}
      {...(editing
        ? {
            primaryButtonText: editor.rebased ? 'Apply again' : 'Save changes',
            secondaryButtonText: 'Cancel',
            primaryButtonDisabled: !canSave,
            loadingStatus: sending === 'edit' ? ('active' as const) : ('inactive' as const),
            loadingDescription: 'Saving to GitHub…',
            onRequestSubmit: () => void save(),
          }
        : {})}
    >
      <div className="issue-detail__facts">
        <Tag size="sm" type={tag.type}>
          {tag.long}
        </Tag>
        <span>
          Opened <DateText iso={issue.createdAt} />
          {issue.author && (
            <>
              {' by '}
              <Person user={issue.author} />
            </>
          )}
        </span>
        {issue.state === 'closed' && issue.closedAt && (
          <span>
            Closed <DateText iso={issue.closedAt} />
          </span>
        )}
        <span>
          Updated <DateText iso={issue.updatedAt} />
        </span>
        <span className="issue-detail__comments">
          <Chat size={16} aria-hidden="true" />
          {issue.comments === 0
            ? 'No comments'
            : `${issue.comments} comment${issue.comments === 1 ? '' : 's'}`}
        </span>
        <Link href={issue.url} target="_blank" rel="noreferrer" renderIcon={Launch} size="sm">
          Open on GitHub
        </Link>
      </div>

      {canChange && !editing && (
        <>
          {noToken && (
            <div className="issue-detail__notices issue-detail__notices--view">
              <ActionableNotification
                inline
                lowContrast
                hideCloseButton
                hasFocus={false}
                closeOnEscape={false}
                kind="info"
                role="status"
                title="A token with write access is needed."
                subtitle={updateIssueFailures.noToken().message}
                actionButtonLabel="Open settings"
                onActionButtonClick={onOpenSettings}
              />
            </div>
          )}
          {noticeBlock && <div className="issue-detail__notices issue-detail__notices--view">{noticeBlock}</div>}
          <div className="issue-detail__actions">
            <Button
              id="issue-edit-button"
              size="sm"
              kind="tertiary"
              renderIcon={Edit}
              disabled={noToken || busy}
              onClick={startEdit}
            >
              Edit
            </Button>
            {(issue.state === 'open' ? (['close-completed', 'close-not-planned'] as const) : (['reopen'] as const)).map(
              (action) => (
                <Button
                  key={action}
                  id={`issue-action-${action}`}
                  size="sm"
                  kind="ghost"
                  renderIcon={
                    action === 'close-completed'
                      ? CheckmarkOutline
                      : action === 'close-not-planned'
                        ? CloseOutline
                        : Undo
                  }
                  disabled={noToken || busy}
                  onClick={() => void changeState(action, start.updatedAt)}
                >
                  {ACTIONS[action].label}
                </Button>
              ),
            )}
            <div className="issue-detail__loading" ref={loadingRef} tabIndex={-1}>
              {sending !== null && sending !== 'edit' && (
                <InlineLoading description={ACTIONS[sending].pending} status="active" />
              )}
            </div>
          </div>
        </>
      )}

      {hasFields && (
        <dl className="issue-detail__fields">
          {issue.labels.length > 0 && (
            <div className="issue-detail__field">
              <dt>Labels</dt>
              <dd>
                <ul className="issue-detail__labels">
                  {issue.labels.map((name) => (
                    <li key={name}>
                      <LabelTag label={labelFor(name, labelsByName)} />
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {issue.assignees.length > 0 && (
            <div className="issue-detail__field">
              <dt>Assignees</dt>
              <dd>
                <ul className="issue-detail__people">
                  {issue.assignees.map((assignee) => (
                    <li key={assignee.login}>
                      <Person user={assignee} />
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
          {issue.milestone !== null && (
            <div className="issue-detail__field">
              <dt>Milestone</dt>
              <dd>
                <span className="issue-detail__milestone">
                  <Milestone size={16} aria-hidden="true" />
                  {issue.milestone}
                </span>
              </dd>
            </div>
          )}
        </dl>
      )}

      {editor ? (
        <div className="issue-detail__body">
          <Stack gap={6}>
            {noticeBlock && <div className="issue-detail__notices">{noticeBlock}</div>}
            <TextInput
              id="issue-edit-title"
              ref={titleRef}
              labelText="Title"
              value={editor.draft.title}
              readOnly={sending === 'edit'}
              invalid={titleBlank || titleTooLong}
              invalidText={titleBlank ? 'A title is required.' : `Use at most ${NEW_ISSUE_TITLE_MAX} characters.`}
              onChange={(event) =>
                setEditor({
                  ...editor,
                  draft: { ...editor.draft, title: event.target.value },
                })
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isImeEnter(event)) {
                  event.preventDefault()
                  void save()
                }
              }}
            />
            <TextArea
              id="issue-edit-body"
              labelText="Description"
              helperText="Markdown. GitHub formats it; here it is plain text."
              rows={12}
              value={editor.draft.body}
              readOnly={sending === 'edit'}
              invalid={bodyTooLong}
              invalidText={`Use at most ${NEW_ISSUE_BODY_MAX.toLocaleString('en-US')} characters.`}
              onChange={(event) =>
                setEditor({
                  ...editor,
                  draft: { ...editor.draft, body: event.target.value },
                })
              }
            />
            {notice?.kind === 'stale' && notice.conflicts.includes('body') && (
              <TextArea
                id="issue-edit-current-body"
                labelText="Description on GitHub now"
                readOnly
                rows={8}
                value={textareaValue(notice.current.body ?? '')}
              />
            )}
          </Stack>
        </div>
      ) : (
        <div className="issue-detail__body">
          <Layer>
            <IssueBody body={issue.body ?? ''} issueUrl={issue.url} />
          </Layer>
        </div>
      )}

      <p className="issue-detail__synced">Loaded with the board at {loadedAt}.</p>
    </Modal>
  )
}
