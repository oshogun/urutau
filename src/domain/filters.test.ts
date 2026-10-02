import { describe, expect, it } from 'vitest'
import { makeIssue } from '../test/fixtures'
import { EMPTY_FILTERS, NONE, countLabels, isFiltering, matchesFilters } from './filters'

const octocat = { login: 'octocat', avatarUrl: '', url: '' }

const issues = [
  makeIssue(1, { title: 'Login page crashes', labels: ['bug'], assignees: [octocat] }),
  makeIssue(2, { title: 'Dark mode', labels: ['enhancement', 'ui'], milestone: 'v1.0' }),
  makeIssue(3, { title: 'Docs typo', labels: ['docs', 'bug'] }),
]

const visible = (filters: typeof EMPTY_FILTERS) =>
  issues.filter((issue) => matchesFilters(issue, filters)).map((issue) => issue.number)

describe('matchesFilters', () => {
  it('matches everything with empty filters', () => {
    expect(isFiltering(EMPTY_FILTERS)).toBe(false)
    expect(visible(EMPTY_FILTERS)).toEqual([1, 2, 3])
  })

  it('matches any of the selected labels', () => {
    expect(visible({ ...EMPTY_FILTERS, labels: ['ui', 'docs'] })).toEqual([2, 3])
  })

  it('searches title and number, requiring every term', () => {
    expect(visible({ ...EMPTY_FILTERS, text: 'login crash' })).toEqual([1])
    expect(visible({ ...EMPTY_FILTERS, text: '#2' })).toEqual([2])
    expect(visible({ ...EMPTY_FILTERS, text: 'login dark' })).toEqual([])
  })

  it('filters by assignee, including unassigned', () => {
    expect(visible({ ...EMPTY_FILTERS, assignee: 'octocat' })).toEqual([1])
    expect(visible({ ...EMPTY_FILTERS, assignee: NONE })).toEqual([2, 3])
  })

  it('filters by milestone, including no milestone', () => {
    expect(visible({ ...EMPTY_FILTERS, milestone: 'v1.0' })).toEqual([2])
    expect(visible({ ...EMPTY_FILTERS, milestone: NONE })).toEqual([1, 3])
  })
})

describe('countLabels', () => {
  it('counts label usage across issues', () => {
    expect(Object.fromEntries(countLabels(issues))).toEqual({
      bug: 2,
      enhancement: 1,
      ui: 1,
      docs: 1,
    })
  })
})
