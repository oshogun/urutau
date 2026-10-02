import { describe, expect, test } from 'vitest'
import { allowedGitHubPath } from './allowlist.ts'

describe('allowedGitHubPath', () => {
  test.each([
    ['repos/acme/widgets', '', 'repos/acme/widgets'],
    ['repos/acme/widgets/labels', 'per_page=100', 'repos/acme/widgets/labels'],
    ['repos/acme/widgets/issues', 'state=open&per_page=100&page=3', 'repos/acme/widgets/issues'],
    ['repos/a/b.c_d-e', '', 'repos/a/b.c_d-e'],
    ['repositories/237159/issues', 'after=Y3Vyc29y+AB%3D', 'repositories/237159/issues'],
    ['repos/acme/%77idgets', '', 'repos/acme/widgets'],
  ])('allows %s?%s', (path, query, expected) => {
    expect(allowedGitHubPath(path, query)).toBe(expected)
  })

  test.each([
    ['repos/acme', ''],
    ['repos/acme/widgets/issues/1', ''],
    ['repos/acme/widgets', 'x=1'],
    ['repos/acme/..', ''],
    ['repos/acme/.', ''],
    ['repos/-acme/widgets', ''],
    ['repos/acme/widgets/issues', 'state=all'],
    ['repos/acme/widgets/issues', 'page=0'],
    ['repos/acme/widgets/issues', 'page=10000'],
    ['repos/acme/widgets/issues', 'per_page=100&per_page=100'],
    ['repos/acme/widgets/issues', 'since=2026-01-01'],
    ['repos/acme/widgets/issues', 'after=a b'],
    ['repos/acme/widgets/issues', 'after=' + 'a'.repeat(201)],
    ['repos/acme/widgets/issues', 'toString=1'],
    ['repos/acme/widgets/issues', '__proto__=1'],
    ['repos/acme/widgets/labels', 'state=open'],
    ['repos/acme%2Fwidgets/issues', ''],
    ['repositories/0/issues', ''],
    ['repositories/1/pulls', ''],
    ['repositories/1', ''],
    ['user', ''],
    ['', ''],
    ['repos/acme/widgets/issues', '%zz=1'],
  ])('refuses %s?%s', (path, query) => {
    expect(allowedGitHubPath(path, query)).toBeNull()
  })
})
