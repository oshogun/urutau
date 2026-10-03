import type { CreateIssueRequest, CreateIssueResponse } from '../domain/api'
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
