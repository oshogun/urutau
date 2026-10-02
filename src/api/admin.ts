import type {
  CreateInviteRequest,
  CreateInviteResponse,
  InviteListResponse,
  UserListResponse,
} from '../domain/api'
import { apiRequest } from './client'

export const USERS_QUERY_KEY = ['users'] as const
export const INVITES_QUERY_KEY = ['invites'] as const

export const listUsers = (signal?: AbortSignal) => apiRequest<UserListResponse>('users', { signal })
export const removeUser = (id: string) =>
  apiRequest<void>(`users/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const listInvites = (signal?: AbortSignal) =>
  apiRequest<InviteListResponse>('invites', { signal })
export const createInvite = (request: CreateInviteRequest = {}) =>
  apiRequest<CreateInviteResponse>('invites', { method: 'POST', body: request })
export const revokeInvite = (id: string) =>
  apiRequest<void>(`invites/${encodeURIComponent(id)}`, { method: 'DELETE' })
