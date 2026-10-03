import type {
  CreateApiTokenRequest,
  CreateApiTokenResponse,
  CreateIntegrationRequest,
  CreateIntegrationResponse,
  CreateInviteRequest,
  CreateInviteResponse,
  IntegrationListResponse,
  InviteListResponse,
  SetGitHubTokenRequest,
  SetGitHubTokenResponse,
  SetIntegrationReposRequest,
  SetIntegrationReposResponse,
  UserListResponse,
} from '../domain/api'
import { apiRequest } from './client'

export const USERS_QUERY_KEY = ['users'] as const
export const INVITES_QUERY_KEY = ['invites'] as const
export const INTEGRATIONS_QUERY_KEY = ['integrations'] as const

export const listUsers = (signal?: AbortSignal) => apiRequest<UserListResponse>('users', { signal })
export const removeUser = (id: string) =>
  apiRequest<void>(`users/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const listInvites = (signal?: AbortSignal) =>
  apiRequest<InviteListResponse>('invites', { signal })
export const createInvite = (request: CreateInviteRequest = {}) =>
  apiRequest<CreateInviteResponse>('invites', { method: 'POST', body: request })
export const revokeInvite = (id: string) =>
  apiRequest<void>(`invites/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const listIntegrations = (signal?: AbortSignal) =>
  apiRequest<IntegrationListResponse>('integrations', { signal })
export const createIntegration = (request: CreateIntegrationRequest) =>
  apiRequest<CreateIntegrationResponse>('integrations', { method: 'POST', body: request })
export const removeIntegration = (id: string) =>
  apiRequest<void>(`integrations/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const createApiToken = (id: string, request: CreateApiTokenRequest) =>
  apiRequest<CreateApiTokenResponse>(`integrations/${encodeURIComponent(id)}/tokens`, {
    method: 'POST',
    body: request,
  })
export const revokeApiToken = (id: string, tokenId: string) =>
  apiRequest<void>(`integrations/${encodeURIComponent(id)}/tokens/${encodeURIComponent(tokenId)}`, {
    method: 'DELETE',
  })
export const setGitHubToken = (id: string, request: SetGitHubTokenRequest) =>
  apiRequest<SetGitHubTokenResponse>(`integrations/${encodeURIComponent(id)}/github-token`, {
    method: 'PUT',
    body: request,
  })
export const clearGitHubToken = (id: string) =>
  apiRequest<void>(`integrations/${encodeURIComponent(id)}/github-token`, { method: 'DELETE' })
export const setIntegrationRepos = (id: string, request: SetIntegrationReposRequest) =>
  apiRequest<SetIntegrationReposResponse>(`integrations/${encodeURIComponent(id)}/repos`, {
    method: 'PUT',
    body: request,
  })
