import type { CreateIssueRequest, CreateIssueResponse, UpdateIssueRequest, UpdateIssueResponse } from '../domain/api'
import type { RepoRef } from '../domain/types'
import { apiRequest } from './client'

/** How long the server path waits for the Urutau server, which itself waits up to 20 s per GitHub attempt. */
export const SERVER_CREATE_TIMEOUT_MS = 60_000

/**
 * POST api/issues/<owner>/<name>: the server creates the issue with the GitHub token it holds for
 * the signed-in Keycloak user. Sends no Authorization header. Without a `signal` the call gives up
 * after SERVER_CREATE_TIMEOUT_MS.
 */
export const createIssueOnServer = (repo: RepoRef, request: CreateIssueRequest, signal?: AbortSignal) =>
  apiRequest<CreateIssueResponse>(
    `issues/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`,
    { method: 'POST', body: request, signal: signal ?? AbortSignal.timeout(SERVER_CREATE_TIMEOUT_MS) },
  )

/**
 * How long the browser waits for the Urutau server. Covers the usual case: up to four GitHub
 * requests at 20 s each when the Keycloak token is fetched quickly. When the token fetches take
 * longer, the route can run past this; the caller then reports that the change may have been
 * applied, because the route keeps running after the browser stops waiting and may still send the
 * PATCH.
 */
export const SERVER_UPDATE_TIMEOUT_MS = 90_000

/**
 * PATCH api/issues/<owner>/<name>/<number>: the server checks the issue's updated_at and changes
 * it with the GitHub token it holds for the signed-in Keycloak user. Sends no Authorization
 * header. Without a `signal` the call gives up after SERVER_UPDATE_TIMEOUT_MS.
 */
export const updateIssueOnServer = (repo: RepoRef, number: number, request: UpdateIssueRequest, signal?: AbortSignal) =>
  apiRequest<UpdateIssueResponse>(
    `issues/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/${number}`,
    { method: 'PATCH', body: request, signal: signal ?? AbortSignal.timeout(SERVER_UPDATE_TIMEOUT_MS) },
  )
