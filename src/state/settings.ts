import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemePreference = 'system' | 'light' | 'dark'

interface SettingsState {
  /**
   * GitHub personal access token. Kept in this browser's local storage and
   * only ever sent to api.github.com. Optional for public repositories.
   */
  token: string
  theme: ThemePreference
  setToken: (token: string) => void
  setTheme: (theme: ThemePreference) => void
}

const THEMES: readonly string[] = ['system', 'light', 'dark']

/** Keeps `token` and `theme` from any stored version and drops everything else (version 1 also held `recentRepos`). */
export function migrateSettings(persisted: unknown): Pick<SettingsState, 'token' | 'theme'> {
  const stored = (persisted ?? {}) as { token?: unknown; theme?: unknown }
  return {
    token: typeof stored.token === 'string' ? stored.token : '',
    theme:
      typeof stored.theme === 'string' && THEMES.includes(stored.theme)
        ? (stored.theme as ThemePreference)
        : 'system',
  }
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      token: '',
      theme: 'system',
      setToken: (token) => set({ token: token.trim() }),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: 'urutau:settings',
      version: 2,
      partialize: ({ token, theme }) => ({ token, theme }),
      migrate: (persisted) => migrateSettings(persisted),
    },
  ),
)
