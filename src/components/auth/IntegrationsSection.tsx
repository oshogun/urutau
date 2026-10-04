import { Add } from '@carbon/icons-react'
import {
  Button,
  CodeSnippet,
  DataTable,
  DataTableSkeleton,
  InlineNotification,
  Modal,
  PasswordInput,
  Select,
  SelectItem,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Table,
  TableBody,
  TableCell,
  TableExpandHeader,
  TableExpandRow,
  TableExpandedRow,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  Tag,
  TextArea,
  TextInput,
  Tile,
} from '@carbon/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  INTEGRATIONS_QUERY_KEY,
  clearGitHubToken,
  createApiToken,
  createIntegration,
  listIntegrations,
  removeIntegration,
  revokeApiToken,
  setGitHubToken,
  setIntegrationRepos,
} from '../../api/admin'
import { ApiError } from '../../api/client'
import type {
  ApiTokenExpiryDays,
  ApiTokenSummary,
  GitHubTokenStatus,
  IntegrationSummary,
} from '../../domain/api'
import { formatDateTime } from './format'
import './auth.scss'

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.')

const TOKEN_EXPIRY_CHOICES: { value: string; days: ApiTokenExpiryDays | null; label: string }[] = [
  { value: '30', days: 30, label: '30 days' },
  { value: '90', days: 90, label: '90 days' },
  { value: '365', days: 365, label: '365 days' },
  { value: 'never', days: null, label: 'Never' },
]

const isPlainHttp = () => window.location.protocol !== 'https:'

/** Every Urutau MCP token and every pasted GitHub token travels in the clear on a plain-HTTP page. */
function PlainHttpWarning() {
  return (
    <InlineNotification
      kind="warning"
      lowContrast
      hideCloseButton
      title="This page is not served over HTTPS."
      subtitle="Urutau MCP tokens on every agent call, and a GitHub token when you save it, cross the network unencrypted. Serve Urutau over HTTPS before connecting agents from other machines."
    />
  )
}

function GitHubTokenTag({ status }: { status: GitHubTokenStatus }) {
  if (!status.set) {
    return (
      <Tag type="gray" size="sm">
        No GitHub token
      </Tag>
    )
  }
  if (!status.readable) {
    return (
      <Tag type="magenta" size="sm">
        Unreadable
      </Tag>
    )
  }
  if (status.status === 'rejected') {
    return (
      <Tag type="red" size="sm">
        Rejected by GitHub
      </Tag>
    )
  }
  return (
    <Tag type="green" size="sm">
      GitHub token set
    </Tag>
  )
}

// The table copies new rows into its own state after the section has rendered, so the new row
// is not in the DOM when the section's effects run. Focusing from the row's own mount avoids that.
function FocusRowButton({ onFocused }: { onFocused: () => void }) {
  const marker = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    marker.current?.closest('tr')?.querySelector<HTMLElement>('.cds--table-expand__button')?.focus()
    onFocused()
  }, [onFocused])
  return <span ref={marker} hidden />
}

/** The integration's name followed by the tag that marks it as an agent account. */
function AgentName({ name }: { name: string }) {
  return (
    <span className="integrations__name">
      {name}
      <Tag type="cool-gray" size="sm" as="span">
        Agent
      </Tag>
    </span>
  )
}

/** The text of each client configuration snippet. None holds a token: they refer to an environment variable or a prompt. */
function connectSnippets(url: string) {
  const allowHttp = url.startsWith('http:')
  const json = (value: unknown) => JSON.stringify(value, null, 2)
  return {
    claudeCommand: `claude mcp add --transport http urutau ${url} --header 'Authorization: Bearer \${URUTAU_MCP_TOKEN}'`,
    claudeFile: json({
      mcpServers: {
        urutau: { type: 'http', url, headers: { Authorization: 'Bearer ${URUTAU_MCP_TOKEN}' } },
      },
    }),
    vscode: json({
      inputs: [{ type: 'promptString', id: 'urutau-token', description: 'Urutau MCP token', password: true }],
      servers: {
        urutau: { type: 'http', url, headers: { Authorization: 'Bearer ${input:urutau-token}' } },
      },
    }),
    cursor: json({
      mcpServers: { urutau: { url, headers: { Authorization: 'Bearer ${env:URUTAU_MCP_TOKEN}' } } },
    }),
    headerFile: [
      'mkdir -p ~/.config/urutau',
      `(umask 077; printf 'Authorization: Bearer %s\\n' "\${URUTAU_MCP_TOKEN:?Set URUTAU_MCP_TOKEN first}" > ~/.config/urutau/mcp-headers)`,
      'chmod 600 ~/.config/urutau/mcp-headers',
    ].join('\n'),
    mcpRemote: json({
      mcpServers: {
        urutau: {
          command: 'npx',
          args: [
            'mcp-remote',
            url,
            '--header-file',
            '<full path of ~/.config/urutau/mcp-headers>',
            ...(allowHttp ? ['--allow-http'] : []),
          ],
        },
      },
    }),
  }
}

function ConnectAgent() {
  const url = new URL('mcp', document.baseURI).href
  const snippets = connectSnippets(url)
  const snippet = (text: string, label: string) => (
    <CodeSnippet type="multi" feedback="Copied" copyButtonDescription={`Copy ${label}`} aria-label={label}>
      {text}
    </CodeSnippet>
  )
  return (
    <div className="integrations__connect" role="group" aria-labelledby="integrations-connect-heading">
      <h3 id="integrations-connect-heading" className="integrations__subheading">
        Connect an agent
      </h3>
      <p className="users__lead">
        Put the Urutau MCP token in the environment variable URUTAU_MCP_TOKEN, or type it when the
        client asks for it. Never write the token itself into an MCP client&apos;s configuration file.
      </p>
      <Tabs>
        <TabList aria-label="MCP client" contained>
          <Tab>Claude Code (command)</Tab>
          <Tab>Claude Code (.mcp.json)</Tab>
          <Tab>VS Code</Tab>
          <Tab>Cursor</Tab>
          <Tab>mcp-remote</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            {snippet(snippets.claudeCommand, 'Claude Code command')}
            <p className="integrations__note">
              The single quotes keep your shell from expanding the variable; Claude Code expands it
              when it connects.
            </p>
          </TabPanel>
          <TabPanel>{snippet(snippets.claudeFile, 'Claude Code .mcp.json')}</TabPanel>
          <TabPanel>
            <p className="integrations__note">Save as .vscode/mcp.json. VS Code asks for the token in a password prompt.</p>
            {snippet(snippets.vscode, 'VS Code mcp.json')}
          </TabPanel>
          <TabPanel>
            <p className="integrations__note">Save as .cursor/mcp.json.</p>
            {snippet(snippets.cursor, 'Cursor mcp.json')}
          </TabPanel>
          <TabPanel>
            <p className="integrations__note">Run once in a terminal where URUTAU_MCP_TOKEN is set:</p>
            {snippet(snippets.headerFile, 'mcp-remote header file commands')}
            <p className="integrations__note">Then add this to the client&apos;s configuration:</p>
            {snippet(snippets.mcpRemote, 'mcp-remote client configuration')}
            <p className="integrations__note">
              Replace the path with the file&apos;s full path, for example
              /home/you/.config/urutau/mcp-headers: mcp-remote does not expand ~. Only you can read the
              file. --header-file needs mcp-remote 0.12.0 or later. On Windows, put the line
              Authorization: Bearer and the token in a text file in your user folder instead, and use a
              path without spaces.
            </p>
          </TabPanel>
        </TabPanels>
      </Tabs>
    </div>
  )
}

type Dialog =
  | { kind: 'revoke'; integration: IntegrationSummary; token: ApiTokenSummary; name: string }
  | { kind: 'clear'; integration: IntegrationSummary }
  | { kind: 'remove'; integration: IntegrationSummary }
  | { kind: 'github'; integration: IntegrationSummary }
  | { kind: 'repos'; integration: IntegrationSummary }

/**
 * A name for each of an integration's tokens that tells them apart: the label and the creation
 * time as the table shows it. Two tokens with the same label and the same displayed time also get
 * their position in the list, which is the table's row order.
 */
function describeTokens(tokens: ApiTokenSummary[]): Map<string, string> {
  const described = tokens.map((token) => `${token.label}, created ${formatDateTime(token.createdAt)}`)
  return new Map(
    tokens.map((token, index) => [
      token.id,
      described.filter((text) => text === described[index]).length > 1
        ? `${described[index]}, number ${index + 1} of ${tokens.length}`
        : described[index],
    ]),
  )
}

interface DetailsProps {
  integration: IntegrationSummary
  githubTokenStorage: boolean
  onDialog: (dialog: Dialog, launcher: HTMLElement) => void
  onChanged: () => void
}

/**
 * The expanded row: tokens, GitHub token and repositories. The shown-once secret lives only in
 * this component's state, so collapsing the row or leaving the page discards it. The call that
 * creates the token is made directly instead of through a mutation, because a mutation keeps its
 * response in the query client's mutation cache.
 */
function IntegrationDetails({ integration, githubTokenStorage, onDialog, onChanged }: DetailsProps) {
  const idPrefix = useId()
  const [label, setLabel] = useState('')
  const [expiry, setExpiry] = useState('90')
  const [labelError, setLabelError] = useState<string | null>(null)
  const [labelErrorFocus, setLabelErrorFocus] = useState(0)
  const [creating, setCreating] = useState(false)
  const [issued, setIssued] = useState<{ label: string; secret: string } | null>(null)
  const tile = useRef<HTMLDivElement>(null)
  const labelInput = useRef<HTMLInputElement>(null)
  const tokenNames = describeTokens(integration.tokens)

  useEffect(() => {
    if (issued) tile.current?.focus()
  }, [issued])

  // The create button is disabled while the request runs, so focus has left it. After a failure it
  // goes to the name field, once the field has rendered as invalid.
  useEffect(() => {
    if (labelErrorFocus > 0) labelInput.current?.focus()
  }, [labelErrorFocus])

  async function createToken() {
    const choice = TOKEN_EXPIRY_CHOICES.find((item) => item.value === expiry)
    setCreating(true)
    setLabelError(null)
    setIssued(null)
    try {
      const response = await createApiToken(integration.id, {
        label,
        expiresInDays: choice ? choice.days : 90,
      })
      setIssued({ label: response.token.label, secret: response.secret })
      setLabel('')
      onChanged()
    } catch (error) {
      setLabelError(errorText(error))
      setLabelErrorFocus((n) => n + 1)
    } finally {
      setCreating(false)
    }
  }

  const { githubToken } = integration
  const name = integration.username

  return (
    <div className="integrations__details">
      <section aria-labelledby={`${idPrefix}-tokens`}>
        <h3 id={`${idPrefix}-tokens`} className="integrations__subheading">
          Urutau MCP tokens
        </h3>
        {integration.tokens.length === 0 ? (
          <p className="users__empty">No tokens yet. An agent needs one to connect.</p>
        ) : (
          <Table size="sm" aria-label={`Tokens of ${name}`}>
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Created</TableHeader>
                <TableHeader>Expires</TableHeader>
                <TableHeader>Last used</TableHeader>
                <TableHeader>Actions</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {integration.tokens.map((token) => {
                const tokenName = tokenNames.get(token.id) ?? token.label
                return (
                  <TableRow key={token.id}>
                    <TableCell>{token.label}</TableCell>
                    <TableCell>{formatDateTime(token.createdAt)}</TableCell>
                    <TableCell>{token.expiresAt ? formatDateTime(token.expiresAt) : 'Never'}</TableCell>
                    <TableCell>{token.lastUsedAt ? formatDateTime(token.lastUsedAt) : 'Never'}</TableCell>
                    <TableCell>
                      <Button
                        kind="danger--ghost"
                        size="sm"
                        aria-label={`Revoke token ${tokenName}`}
                        onClick={(event) =>
                          onDialog({ kind: 'revoke', integration, token, name: tokenName }, event.currentTarget)
                        }
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                  )
              })}
            </TableBody>
          </Table>
        )}
        <form
          className="users__create"
          onSubmit={(event) => {
            event.preventDefault()
            void createToken()
          }}
        >
          <TextInput
            id={`${idPrefix}-token-name`}
            ref={labelInput}
            labelText="Token name"
            placeholder="laptop"
            required
            maxLength={64}
            value={label}
            invalid={labelError !== null}
            invalidText={labelError ?? ''}
            onChange={(event) => setLabel(event.target.value)}
          />
          <Select
            id={`${idPrefix}-token-expiry`}
            labelText="Token expires after"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
          >
            {TOKEN_EXPIRY_CHOICES.map((choice) => (
              <SelectItem key={choice.value} value={choice.value} text={choice.label} />
            ))}
          </Select>
          <Button type="submit" renderIcon={Add} disabled={creating || label.trim() === ''}>
            Create token
          </Button>
        </form>
        {issued && (
          <Tile
            ref={tile}
            className="users__link"
            tabIndex={-1}
            aria-labelledby={`${idPrefix}-issued`}
          >
            <p className="users__link-label" id={`${idPrefix}-issued`}>
              Urutau MCP token for {issued.label}. It is shown only now: copy it before leaving this
              page. Give it to the agent; Urutau keeps only a fingerprint of it.
            </p>
            <CodeSnippet
              type="single"
              feedback="Copied"
              copyButtonDescription="Copy token"
              aria-label="Urutau MCP token"
            >
              {issued.secret}
            </CodeSnippet>
          </Tile>
        )}
      </section>

      <section aria-labelledby={`${idPrefix}-github`}>
        <h3 id={`${idPrefix}-github`} className="integrations__subheading">
          GitHub token
        </h3>
        <div className="integrations__row">
          <GitHubTokenTag status={githubToken} />
          {githubToken.set && githubToken.updatedAt && (
            <span className="integrations__meta">Set at {formatDateTime(githubToken.updatedAt)}</span>
          )}
        </div>
        <div className="integrations__row">
          <Button
            kind="tertiary"
            size="sm"
            disabled={!githubTokenStorage}
            aria-label={`${githubToken.set ? 'Replace' : 'Set'} GitHub token for ${name}`}
            onClick={(event) => onDialog({ kind: 'github', integration }, event.currentTarget)}
          >
            {githubToken.set ? 'Replace GitHub token' : 'Set GitHub token'}
          </Button>
          {githubToken.set && (
            <Button
              kind="danger--ghost"
              size="sm"
              aria-label={`Clear GitHub token of ${name}`}
              onClick={(event) => onDialog({ kind: 'clear', integration }, event.currentTarget)}
            >
              Clear
            </Button>
          )}
        </div>
      </section>

      <section aria-labelledby={`${idPrefix}-repos`}>
        <h3 id={`${idPrefix}-repos`} className="integrations__subheading">
          Repositories
        </h3>
        {integration.repos.length === 0 ? (
          <p className="users__empty">
            None yet. The integration can read no board until you add repositories.
          </p>
        ) : (
          <ul className="integrations__repos">
            {integration.repos.map((repo) => (
              <li key={repo}>{repo}</li>
            ))}
          </ul>
        )}
        <Button
          kind="tertiary"
          size="sm"
          aria-label={`Edit repositories of ${name}`}
          onClick={(event) => onDialog({ kind: 'repos', integration }, event.currentTarget)}
        >
          Edit repositories
        </Button>
      </section>
    </div>
  )
}

interface FormModalProps {
  integration: IntegrationSummary
  launcher: RefObject<HTMLElement | null>
  onClose: () => void
  onSaved: () => void
}

/**
 * Asks for the GitHub token. The value is in this component's state only and is sent with a direct
 * call (a mutation would keep it as its variables); closing the dialog unmounts it, whatever the outcome.
 */
function GitHubTokenModal({ integration, launcher, onClose, onSaved }: FormModalProps) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [generalError, setGeneralError] = useState<string | null>(null)
  const [errorFocus, setErrorFocus] = useState(0)
  const field = useRef<HTMLInputElement>(null)
  const notice = useRef<HTMLDivElement>(null)

  // The save button is disabled while the request runs, so focus has left it. After a failure it
  // goes to whatever shows the error, once that has rendered.
  useEffect(() => {
    if (errorFocus === 0) return
    if (notice.current) notice.current.focus()
    else field.current?.focus()
  }, [errorFocus])

  async function save() {
    setBusy(true)
    setFieldError(null)
    setGeneralError(null)
    try {
      await setGitHubToken(integration.id, { token: value })
      onSaved()
    } catch (error) {
      const code = error instanceof ApiError ? error.code : null
      if (code === 'not-a-github-token' || code === 'unsupported-token-format') setFieldError(errorText(error))
      else setGeneralError(errorText(error))
      setBusy(false)
      setErrorFocus((n) => n + 1)
    }
  }

  return (
    <Modal
      open
      size="sm"
      launcherButtonRef={launcher}
      selectorPrimaryFocus="#integration-github-token"
      modalHeading={`GitHub token for ${integration.username}`}
      primaryButtonText="Save GitHub token"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={busy || value.trim() === ''}
      onRequestSubmit={() => void save()}
      onRequestClose={onClose}
    >
      <div className="integrations__modal">
        {isPlainHttp() && <PlainHttpWarning />}
        {generalError && (
          <div ref={notice} tabIndex={-1}>
            <InlineNotification
              role="alert"
              kind="error"
              lowContrast
              hideCloseButton
              title={generalError}
            />
          </div>
        )}
        <p>
          Urutau keeps this token, encrypted, on its server, and uses it only to read issues from
          GitHub for this integration. Use a fine-grained token with Issues: read and Metadata: read
          on only the repositories this integration needs, ideally from a separate GitHub account for
          bots.
        </p>
        <PasswordInput
          id="integration-github-token"
          ref={field}
          labelText="GitHub token (Urutau keeps this)"
          helperText="Starts with github_pat_ or ghp_."
          autoComplete="new-password"
          value={value}
          invalid={fieldError !== null}
          invalidText={fieldError ?? ''}
          onChange={(event) => setValue(event.target.value)}
        />
      </div>
    </Modal>
  )
}

function ReposModal({ integration, launcher, onClose, onSaved }: FormModalProps) {
  const [text, setText] = useState(integration.repos.join('\n'))
  const field = useRef<HTMLTextAreaElement>(null)
  const save = useMutation({
    mutationFn: () =>
      setIntegrationRepos(integration.id, {
        repos: text
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
      }),
    onSuccess: onSaved,
    // The save button is disabled while the request runs, so focus has left it.
    onError: () => field.current?.focus(),
  })

  // Modal focuses the field first; this runs after it and moves the caret from the start of a
  // saved list to its end, so typing adds to the list instead of writing onto the first line.
  useEffect(() => {
    const el = field.current
    if (el) el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  return (
    <Modal
      open
      size="sm"
      launcherButtonRef={launcher}
      selectorPrimaryFocus="#integration-repos"
      modalHeading={`Repositories ${integration.username} may read`}
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={save.isPending}
      onRequestSubmit={() => save.mutate()}
      onRequestClose={onClose}
    >
      <TextArea
        id="integration-repos"
        ref={field}
        labelText="One repository per line, as owner/name"
        rows={8}
        value={text}
        invalid={save.isError}
        invalidText={save.error ? errorText(save.error) : ''}
        onChange={(event) => setText(event.target.value)}
      />
    </Modal>
  )
}

/** Admin section of the Users page: agent accounts, their MCP tokens, GitHub token and repositories. */
export function IntegrationsSection() {
  const queryClient = useQueryClient()
  const integrations = useQuery({
    queryKey: INTEGRATIONS_QUERY_KEY,
    queryFn: ({ signal }) => listIntegrations(signal),
    retry: false,
  })

  const [name, setName] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [headingFocus, setHeadingFocus] = useState(0)
  const [nameErrorFocus, setNameErrorFocus] = useState(0)
  const [launcherFocus, setLauncherFocus] = useState(0)
  const launcher = useRef<HTMLElement | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const loadError = useRef<HTMLDivElement>(null)
  // Set when this page asked for the refetch itself, so a failure of it takes focus.
  const focusLoadError = useRef(false)
  // Name of the integration just created, until its row has rendered and taken focus.
  const focusNewRow = useRef<string | null>(null)

  useEffect(() => {
    if (headingFocus > 0) heading.current?.focus()
  }, [headingFocus])

  // The create button is disabled while the request runs, so focus has left it. After a failure it
  // goes to the name field, once the field has rendered as invalid.
  useEffect(() => {
    if (nameErrorFocus > 0) nameInput.current?.focus()
  }, [nameErrorFocus])

  // Focus moves in an effect, after the commit that removes the dialog. Moving it
  // while the dialog is still mounted lets Carbon's focus wrap pull it back inside.
  useEffect(() => {
    if (launcherFocus === 0) return
    if (launcher.current?.isConnected) launcher.current.focus()
    else heading.current?.focus()
  }, [launcherFocus])

  const clearNewRow = useCallback(() => {
    focusNewRow.current = null
  }, [])

  const refresh = () => queryClient.invalidateQueries({ queryKey: INTEGRATIONS_QUERY_KEY })

  const create = useMutation({
    mutationFn: () => createIntegration({ username: name.trim() }),
    onSuccess: ({ integration }) => {
      focusNewRow.current = integration.username
      setName('')
      setNameError(null)
      setActionError(null)
      setExpanded(integration.id)
      focusLoadError.current = true
      void refresh()
    },
    onError: (error) => {
      setNameError(errorText(error))
      setNameErrorFocus((n) => n + 1)
    },
  })

  // The dialogs unmount when closed, so Carbon does not return focus itself.
  const returnFocus = () => setLauncherFocus((n) => n + 1)

  const confirm = useMutation({
    mutationFn: async (target: Dialog) => {
      if (target.kind === 'revoke') await revokeApiToken(target.integration.id, target.token.id)
      else if (target.kind === 'clear') await clearGitHubToken(target.integration.id)
      else if (target.kind === 'remove') await removeIntegration(target.integration.id)
    },
    onSuccess: (_result, target) => {
      setDialog(null)
      setActionError(null)
      if (target.kind === 'remove' && expanded === target.integration.id) setExpanded(null)
      // The launcher of these three stops rendering once the list refetches.
      setHeadingFocus((n) => n + 1)
      void refresh()
    },
    onError: (error) => {
      setDialog(null)
      setActionError(errorText(error))
      returnFocus()
    },
  })

  const openDialog = (next: Dialog, button: HTMLElement) => {
    launcher.current = button
    confirm.reset()
    setDialog(next)
  }
  const closeDialog = () => {
    setDialog(null)
    returnFocus()
  }
  const saved = () => {
    setDialog(null)
    setActionError(null)
    void refresh()
    returnFocus()
  }

  const list = integrations.data?.integrations ?? []

  // A pending request that never matched a row (the refetch finished without it) is dropped, so
  // it cannot take focus from something else later.
  useEffect(() => {
    if (integrations.isFetching || focusNewRow.current === null) return
    const names = integrations.data?.integrations.map((item) => item.username) ?? []
    if (!names.includes(focusNewRow.current)) focusNewRow.current = null
  }, [integrations.isFetching, integrations.data])
  // A failed refetch replaces the table, and the element that had focus with it, so the notice takes
  // focus when this page asked for the refetch or when focus has fallen to the page. A failed first
  // load had no table, so focus stays where it is and the alert announces the error. The request
  // flag is dropped once a fetch ends, so a later failed refetch does not inherit it.
  useEffect(() => {
    if (integrations.isFetching) return
    if (!integrations.isError) {
      focusLoadError.current = false
      return
    }
    const active = document.activeElement
    if (focusLoadError.current || (integrations.isRefetchError && (!active || active === document.body))) {
      loadError.current?.focus()
    }
    focusLoadError.current = false
  }, [
    integrations.isFetching,
    integrations.isError,
    integrations.isRefetchError,
    integrations.errorUpdatedAt,
    integrations.dataUpdatedAt,
  ])
  const githubTokenStorage = integrations.data?.githubTokenStorage ?? true
  const rows = list.map((integration) => ({
    id: integration.id,
    username: integration.username,
    github: '',
    repos: String(integration.repos.length),
    tokens: String(integration.tokens.length),
    actions: '',
  }))

  return (
    <section className="users__section" aria-labelledby="integrations-heading">
      <h2 id="integrations-heading" ref={heading} tabIndex={-1} className="users__heading">
        Agent integrations
      </h2>
      <p className="users__lead">
        An agent integration lets an AI agent read boards and move cards through Urutau&apos;s MCP
        server. It is an account of its own: it cannot sign in, it is never the admin, and its changes
        show as &quot;Agent&quot; on boards.
      </p>

      <div className="integrations__notices">
        {isPlainHttp() && <PlainHttpWarning />}
        {integrations.data && !githubTokenStorage && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="GitHub tokens cannot be stored."
            subtitle="The server has no TOKEN_ENCRYPTION_KEY. The person who runs the server sets it (see the README) and restarts it; until then integrations cannot read GitHub."
          />
        )}
        {actionError && (
          <InlineNotification
            role="alert"
            kind="error"
            lowContrast
            title={actionError}
            onCloseButtonClick={() => setActionError(null)}
          />
        )}
      </div>

      <form
        className="users__create integrations__create"
        onSubmit={(event) => {
          event.preventDefault()
          create.mutate()
        }}
      >
        <TextInput
          id="integration-name"
          ref={nameInput}
          labelText="Integration name"
          helperText="3 to 32 letters, digits, dots, dashes or underscores. People and integrations share names."
          value={name}
          invalid={nameError !== null}
          invalidText={nameError ?? ''}
          onChange={(event) => {
            setName(event.target.value)
            setNameError(null)
          }}
        />
        <Button type="submit" renderIcon={Add} disabled={create.isPending || name.trim() === ''}>
          Create integration
        </Button>
      </form>

      {integrations.isPending ? (
        <DataTableSkeleton columnCount={5} rowCount={2} showHeader={false} showToolbar={false} />
      ) : integrations.isError ? (
        <div ref={loadError} tabIndex={-1}>
          <InlineNotification
            role="alert"
            kind="error"
            lowContrast
            hideCloseButton
            title="Could not load the integrations."
            subtitle={integrations.error.message}
          />
        </div>
      ) : list.length === 0 ? (
        <p className="users__empty">No agent integrations yet.</p>
      ) : (
        <DataTable
          rows={rows}
          headers={[
            { key: 'username', header: 'Name' },
            { key: 'github', header: 'GitHub token' },
            { key: 'repos', header: 'Repositories' },
            { key: 'tokens', header: 'Tokens' },
            { key: 'actions', header: 'Actions' },
          ]}
        >
          {({ rows: tableRows, headers, getTableProps, getHeaderProps }) => (
            <Table {...getTableProps()} aria-label="Agent integrations">
              <TableHead>
                <TableRow>
                  <TableExpandHeader aria-label="Details" />
                  {headers.map((header) => {
                    const { key, ...props } = getHeaderProps({ header })
                    return (
                      <TableHeader key={key} {...props}>
                        {header.header}
                      </TableHeader>
                    )
                  })}
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((row) => {
                  const integration = list.find((item) => item.id === row.id)
                  if (!integration) return null
                  const isExpanded = expanded === integration.id
                  return [
                    <TableExpandRow
                      key={row.id}
                      aria-label={`Show details of ${integration.username}`}
                      isExpanded={isExpanded}
                      onExpand={() => setExpanded(isExpanded ? null : integration.id)}
                    >
                      <TableCell>
                        {focusNewRow.current === integration.username && (
                          <FocusRowButton onFocused={clearNewRow} />
                        )}
                        <AgentName name={integration.username} />
                      </TableCell>
                      <TableCell>
                        <GitHubTokenTag status={integration.githubToken} />
                      </TableCell>
                      <TableCell>{integration.repos.length}</TableCell>
                      <TableCell>{integration.tokens.length}</TableCell>
                      <TableCell>
                        <Button
                          kind="danger--ghost"
                          size="sm"
                          aria-label={`Remove ${integration.username}`}
                          onClick={(event) => openDialog({ kind: 'remove', integration }, event.currentTarget)}
                        >
                          Remove
                        </Button>
                      </TableCell>
                    </TableExpandRow>,
                    isExpanded && (
                      <TableExpandedRow key={`${row.id}-details`} colSpan={headers.length + 1}>
                        <IntegrationDetails
                          integration={integration}
                          githubTokenStorage={githubTokenStorage}
                          onDialog={openDialog}
                          onChanged={() => void refresh()}
                        />
                      </TableExpandedRow>
                    ),
                  ]
                })}
              </TableBody>
            </Table>
          )}
        </DataTable>
      )}

      <ConnectAgent />

      {dialog && (dialog.kind === 'revoke' || dialog.kind === 'clear' || dialog.kind === 'remove') && (
        <Modal
          open
          danger
          size="sm"
          launcherButtonRef={launcher}
          modalHeading={
            dialog.kind === 'revoke'
              ? `Revoke ${dialog.name}?`
              : dialog.kind === 'clear'
                ? `Clear the GitHub token of ${dialog.integration.username}?`
                : `Remove ${dialog.integration.username}?`
          }
          primaryButtonText={
            dialog.kind === 'revoke' ? 'Revoke token' : dialog.kind === 'clear' ? 'Clear token' : 'Remove integration'
          }
          secondaryButtonText="Cancel"
          primaryButtonDisabled={confirm.isPending}
          onRequestSubmit={() => confirm.mutate(dialog)}
          onRequestClose={closeDialog}
        >
          <p>
            {dialog.kind === 'revoke'
              ? 'Agents using this token stop working at once, also in the middle of a call.'
              : dialog.kind === 'clear'
                ? 'Urutau deletes its copy. The token still works at GitHub until you revoke it there.'
                : 'Its tokens stop working at once and Urutau deletes its GitHub token. Boards it changed stay as they are.'}
          </p>
        </Modal>
      )}
      {dialog?.kind === 'github' && (
        <GitHubTokenModal integration={dialog.integration} launcher={launcher} onClose={closeDialog} onSaved={saved} />
      )}
      {dialog?.kind === 'repos' && (
        <ReposModal integration={dialog.integration} launcher={launcher} onClose={closeDialog} onSaved={saved} />
      )}
    </section>
  )
}
