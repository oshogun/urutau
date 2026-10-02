import { describe, expect, it } from 'vitest'
import { formatRepo, parseRepoInput, repoKey } from './repoRef'

describe('parseRepoInput', () => {
  it.each([
    'facebook/react',
    ' facebook/react ',
    'https://github.com/facebook/react',
    'https://github.com/facebook/react/',
    'https://github.com/facebook/react/issues?q=is%3Aopen',
    'github.com/facebook/react',
    'https://www.github.com/facebook/react.git',
    'git@github.com:facebook/react.git',
  ])('parses %j', (input) => {
    expect(parseRepoInput(input)).toEqual({ owner: 'facebook', name: 'react' })
  })

  it('keeps dots, dashes and underscores in repository names', () => {
    expect(parseRepoInput('vitejs/vite-plugin.react_v2')).toEqual({
      owner: 'vitejs',
      name: 'vite-plugin.react_v2',
    })
  })

  it.each(['', 'react', 'facebook/', '/react', 'bad owner/react', 'facebook/..', '-x/y'])(
    'rejects %j',
    (input) => {
      expect(parseRepoInput(input)).toBeNull()
    },
  )
})

describe('repoKey', () => {
  it('is case-insensitive', () => {
    expect(repoKey({ owner: 'Facebook', name: 'React' })).toBe('facebook/react')
    expect(formatRepo({ owner: 'Facebook', name: 'React' })).toBe('Facebook/React')
  })
})
