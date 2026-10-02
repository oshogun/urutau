import { Add } from '@carbon/icons-react'
import {
  Button,
  CodeSnippet,
  DataTable,
  DataTableSkeleton,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tile,
} from '@carbon/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
  INVITES_QUERY_KEY,
  USERS_QUERY_KEY,
  createInvite,
  listInvites,
  listUsers,
  removeUser,
  revokeInvite,
} from '../../api/admin'
import type { CreateInviteResponse, InviteSummary, UserSummary } from '../../domain/api'
import { formatDateTime } from './format'
import './auth.scss'

const EXPIRY_CHOICES = [
  { hours: 24, label: '1 day' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
]

function inviteLink(token: string): string {
  return `${window.location.origin}${window.location.pathname}#invite=${token}`
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Something went wrong.')

type Pending = { kind: 'user'; user: UserSummary } | { kind: 'invite'; invite: InviteSummary }

/** Admin screen: invite links and the users who can sign in. */
export function UsersPage() {
  const queryClient = useQueryClient()
  const users = useQuery({ queryKey: USERS_QUERY_KEY, queryFn: ({ signal }) => listUsers(signal), retry: false })
  const invites = useQuery({
    queryKey: INVITES_QUERY_KEY,
    queryFn: ({ signal }) => listInvites(signal),
    retry: false,
  })

  const [hours, setHours] = useState(168)
  const [created, setCreated] = useState<CreateInviteResponse | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => createInvite({ expiresInHours: hours }),
    onSuccess: (response) => {
      setCreated(response)
      setActionError(null)
      void queryClient.invalidateQueries({ queryKey: INVITES_QUERY_KEY })
    },
    onError: (error) => setActionError(errorText(error)),
  })

  const confirm = useMutation({
    mutationFn: async (target: Pending) => {
      if (target.kind === 'user') await removeUser(target.user.id)
      else await revokeInvite(target.invite.id)
    },
    onSuccess: (_result, target) => {
      setPending(null)
      setActionError(null)
      if (target.kind === 'invite' && created?.invite.id === target.invite.id) setCreated(null)
      void queryClient.invalidateQueries({
        queryKey: target.kind === 'user' ? USERS_QUERY_KEY : INVITES_QUERY_KEY,
      })
    },
    onError: (error) => {
      setPending(null)
      setActionError(errorText(error))
    },
  })

  const userRows = (users.data?.users ?? []).map((user) => ({
    id: user.id,
    username: user.displayName ? `${user.username} (${user.displayName})` : user.username,
    role: user.isAdmin ? 'Administrator' : 'Member',
    sign: user.authMethod === 'keycloak' ? 'Keycloak' : 'Password',
    created: formatDateTime(user.createdAt),
  }))
  const inviteRows = (invites.data?.invites ?? []).map((invite) => ({
    id: invite.id,
    createdBy: invite.createdBy?.username ?? 'A removed user',
    created: formatDateTime(invite.createdAt),
    expires: formatDateTime(invite.expiresAt),
  }))

  return (
    <div className="users">
      <title>Users · Urutau</title>
      <h1 className="users__title">Users</h1>

      {actionError && (
        <InlineNotification
          role="alert"
          kind="error"
          lowContrast
          title={actionError}
          onCloseButtonClick={() => setActionError(null)}
        />
      )}

      <section className="users__section" aria-labelledby="users-invite-heading">
        <h2 id="users-invite-heading" className="users__heading">
          Invite someone
        </h2>
        <p className="users__lead">
          An invite link lets one person choose a username and password. It works once, and until it
          expires.
        </p>
        <div className="users__create">
          <Select
            id="invite-expiry"
            labelText="Link expires after"
            value={String(hours)}
            onChange={(event) => setHours(Number(event.target.value))}
          >
            {EXPIRY_CHOICES.map((choice) => (
              <SelectItem key={choice.hours} value={String(choice.hours)} text={choice.label} />
            ))}
          </Select>
          <Button
            renderIcon={Add}
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            Create invite link
          </Button>
        </div>
        {created && (
          <Tile className="users__link">
            <p className="users__link-label" id="users-new-link">
              Invite link, valid until {formatDateTime(created.invite.expiresAt)}. It is shown only
              now, so copy it before leaving this page.
            </p>
            <CodeSnippet
              type="single"
              feedback="Copied"
              copyButtonDescription="Copy invite link"
              aria-label="Invite link"
              aria-describedby="users-new-link"
            >
              {inviteLink(created.token)}
            </CodeSnippet>
          </Tile>
        )}
      </section>

      <section className="users__section" aria-labelledby="users-open-invites-heading">
        <h2 id="users-open-invites-heading" className="users__heading">
          Open invites
        </h2>
        {invites.isPending ? (
          <DataTableSkeleton columnCount={4} rowCount={2} showHeader={false} showToolbar={false} />
        ) : invites.isError ? (
          <InlineNotification
            role="alert"
            kind="error"
            lowContrast
            hideCloseButton
            title="Could not load the invites."
            subtitle={invites.error.message}
          />
        ) : inviteRows.length === 0 ? (
          <p className="users__empty">No open invites.</p>
        ) : (
          <DataTable
            rows={inviteRows}
            headers={[
              { key: 'createdBy', header: 'Created by' },
              { key: 'created', header: 'Created' },
              { key: 'expires', header: 'Expires' },
              { key: 'actions', header: 'Actions' },
            ]}
          >
            {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
              <TableContainer>
                <Table {...getTableProps()} aria-label="Open invites">
                  <TableHead>
                    <TableRow>
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
                    {rows.map((row) => {
                      const { key, ...props } = getRowProps({ row })
                      const invite = invites.data?.invites.find((item) => item.id === row.id)
                      return (
                        <TableRow key={key} {...props}>
                          {row.cells.map((cell) =>
                            cell.info.header === 'actions' ? (
                              <TableCell key={cell.id}>
                                <Button
                                  kind="danger--ghost"
                                  size="sm"
                                  aria-label={`Revoke invite created ${row.cells[1]?.value}`}
                                  onClick={() => invite && setPending({ kind: 'invite', invite })}
                                >
                                  Revoke
                                </Button>
                              </TableCell>
                            ) : (
                              <TableCell key={cell.id}>{cell.value}</TableCell>
                            ),
                          )}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </DataTable>
        )}
      </section>

      <section className="users__section" aria-labelledby="users-list-heading">
        <h2 id="users-list-heading" className="users__heading">
          People with an account
        </h2>
        {users.isPending ? (
          <DataTableSkeleton columnCount={5} rowCount={3} showHeader={false} showToolbar={false} />
        ) : users.isError ? (
          <InlineNotification
            role="alert"
            kind="error"
            lowContrast
            hideCloseButton
            title="Could not load the users."
            subtitle={users.error.message}
          />
        ) : (
          <DataTable
            rows={userRows}
            headers={[
              { key: 'username', header: 'Username' },
              { key: 'role', header: 'Role' },
              { key: 'sign', header: 'Signs in with' },
              { key: 'created', header: 'Joined' },
              { key: 'actions', header: 'Actions' },
            ]}
          >
            {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
              <TableContainer>
                <Table {...getTableProps()} aria-label="Users">
                  <TableHead>
                    <TableRow>
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
                    {rows.map((row) => {
                      const { key, ...props } = getRowProps({ row })
                      const user = users.data?.users.find((item) => item.id === row.id)
                      return (
                        <TableRow key={key} {...props}>
                          {row.cells.map((cell) =>
                            cell.info.header === 'actions' ? (
                              <TableCell key={cell.id}>
                                {user && !user.isAdmin && (
                                  <Button
                                    kind="danger--ghost"
                                    size="sm"
                                    aria-label={`Remove ${user.username}`}
                                    onClick={() => setPending({ kind: 'user', user })}
                                  >
                                    Remove
                                  </Button>
                                )}
                              </TableCell>
                            ) : (
                              <TableCell key={cell.id}>{cell.value}</TableCell>
                            ),
                          )}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </DataTable>
        )}
      </section>

      {pending && (
        <Modal
          open
          danger
          size="sm"
          modalHeading={pending.kind === 'user' ? `Remove ${pending.user.username}?` : 'Revoke this invite?'}
          primaryButtonText={pending.kind === 'user' ? 'Remove user' : 'Revoke invite'}
          secondaryButtonText="Cancel"
          primaryButtonDisabled={confirm.isPending}
          onRequestSubmit={() => confirm.mutate(pending)}
          onRequestClose={() => setPending(null)}
        >
          <p>
            {pending.kind === 'user'
              ? 'They are signed out and can no longer sign in. Boards they changed stay as they are.'
              : 'The link stops working. Anyone who has it will see that it is not valid.'}
          </p>
        </Modal>
      )}
    </div>
  )
}
