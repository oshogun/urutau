import type { InviteCheckRequest, InviteCheckResponse } from '../domain/api'
import { apiRequest } from './client'

/** Public: tells the invite page whether a token is still usable before asking for credentials. */
export const checkInvite = (token: string) =>
  apiRequest<InviteCheckResponse>('invites/check', {
    method: 'POST',
    body: { token } satisfies InviteCheckRequest,
  })
