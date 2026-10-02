import html from '../../index.html?raw'
import { beforeEach, describe, expect, it } from 'vitest'
import { useSettings } from './settings'

beforeEach(() => localStorage.clear())

describe('urutau:settings migration', () => {
  it('moves version 1 to version 2, keeping token and theme and dropping recentRepos', async () => {
    localStorage.setItem(
      'urutau:settings',
      JSON.stringify({ state: { token: 'ghp_x', theme: 'dark', recentRepos: ['acme/widgets'] }, version: 1 }),
    )
    await useSettings.persist.rehydrate()
    expect(useSettings.getState()).toMatchObject({ token: 'ghp_x', theme: 'dark' })
    expect(useSettings.getState()).not.toHaveProperty('recentRepos')
    useSettings.getState().setTheme('light')
    expect(JSON.parse(localStorage.getItem('urutau:settings') ?? '{}')).toEqual({
      state: { token: 'ghp_x', theme: 'light' },
      version: 2,
    })
  })

  it('falls back to defaults for malformed version 1 values', async () => {
    localStorage.setItem('urutau:settings', JSON.stringify({ state: { token: 5, theme: 'neon' }, version: 1 }))
    await useSettings.persist.rehydrate()
    expect(useSettings.getState()).toMatchObject({ token: '', theme: 'system' })
  })

  it('writes the keys the pre-paint script in index.html reads', () => {
    expect(html).toContain("localStorage.getItem('urutau:settings')")
    expect(html).toContain('saved.state.theme')
    useSettings.getState().setTheme('dark')
    const saved = JSON.parse(localStorage.getItem('urutau:settings') ?? '{}')
    expect(saved.state.theme).toBe('dark')
  })
})
