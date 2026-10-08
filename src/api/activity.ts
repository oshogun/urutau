import { CLIENT_ID_HEADER } from '../domain/api'
import type {
  AcceptItemRequest,
  AcceptItemResponse,
  BoardActivityResponse,
  IssueActivityResponse,
  SetEstimateRequest,
  StoredBoard,
} from '../domain/api'
import { CLIENT_ID, apiRequest } from './client'

const segment = encodeURIComponent
const boardPath = (repoKey: string) => `boards/${repoKey.split('/').map(segment).join('/')}`
const writeHeaders = { [CLIENT_ID_HEADER]: CLIENT_ID }

export function getBoardActivity(repoKey: string): Promise<BoardActivityResponse> {
  return apiRequest<BoardActivityResponse>(`${boardPath(repoKey)}/activity`)
}

export function getIssueActivity(repoKey: string, issue: number): Promise<IssueActivityResponse> {
  return apiRequest<IssueActivityResponse>(`${boardPath(repoKey)}/activity/${issue}`)
}

/** Releases the claim on an issue if run `runId` still holds it; 409 `claim-changed` when another run does. */
export function releaseClaim(repoKey: string, issue: number, runId: string): Promise<void> {
  return apiRequest<void>(`${boardPath(repoKey)}/claims/${issue}?runId=${segment(runId)}`, {
    method: 'DELETE',
    headers: writeHeaders,
  })
}

/** Accepts a normative item of a run; 409 `item-resolved` when it was already closed. */
export function acceptItem(repoKey: string, runId: string, itemId: string, request: AcceptItemRequest = {}): Promise<AcceptItemResponse> {
  return apiRequest<AcceptItemResponse>(`${boardPath(repoKey)}/runs/${segment(runId)}/items/${segment(itemId)}/accept`, {
    method: 'POST',
    body: request,
    headers: writeHeaders,
  })
}

/** Sets an estimate; the server stamps who set it and when, and saves the board with a new version. */
export function putEstimate(repoKey: string, issue: number, request: SetEstimateRequest): Promise<StoredBoard> {
  return apiRequest<StoredBoard>(`${boardPath(repoKey)}/estimates/${issue}`, {
    method: 'PUT',
    body: request,
    headers: writeHeaders,
  })
}

export function deleteEstimate(repoKey: string, issue: number): Promise<StoredBoard> {
  return apiRequest<StoredBoard>(`${boardPath(repoKey)}/estimates/${issue}`, {
    method: 'DELETE',
    headers: writeHeaders,
  })
}
