import type { ServerSettings, UpdateServerSettingsRequest } from '../domain/api'
import { apiRequest } from './client'

export const SERVER_SETTINGS_QUERY_KEY = ['server-settings'] as const

/** GET api/settings: the server-wide switches, readable by every signed-in user. */
export const getServerSettings = (signal?: AbortSignal) =>
  apiRequest<ServerSettings>('settings', { signal })

/** PATCH api/settings: admin only. */
export const updateServerSettings = (request: UpdateServerSettingsRequest) =>
  apiRequest<ServerSettings>('settings', { method: 'PATCH', body: request })
