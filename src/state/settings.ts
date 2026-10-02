import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemePreference = 'system' | 'light' | 'dark'

const MAX_RECENT_REPOS = 8

interface SettingsState {
  /**
   * GitHub personal access token. Kept in this browser's local storage and
   * only ever sent to api.github.com. Optional for public repositories.
   */
  token: string
  theme: ThemePreference
  /** Recently opened repositories as `owner/name`, most recent first. */
  recentRepos: string[]
  setToken: (token: string) => void
  setTheme: (theme: ThemePreference) => void
  rememberRepo: (fullName: string) => void
  forgetRepo: (fullName: string) => void
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      token: '',
      theme: 'system',
      recentRepos: [],
      setToken: (token) => set({ token: token.trim() }),
      setTheme: (theme) => set({ theme }),
      rememberRepo: (fullName) =>
        set((state) => ({
          recentRepos: [
            fullName,
            ...state.recentRepos.filter((repo) => !sameRepo(repo, fullName)),
          ].slice(0, MAX_RECENT_REPOS),
        })),
      forgetRepo: (fullName) =>
        set((state) => ({
          recentRepos: state.recentRepos.filter((repo) => !sameRepo(repo, fullName)),
        })),
    }),
    {
      name: 'urutau:settings',
      version: 1,
      partialize: ({ token, theme, recentRepos }) => ({ token, theme, recentRepos }),
    },
  ),
)
