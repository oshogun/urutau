import { describe, expect, it } from 'vitest'
import { fetchAllPages, fetchJson, parseNextLink, type GitHubTransport } from './paging'

const ROOT = 'https://api.github.com'

function transportOf(pages: Record<string, { body: unknown; link?: string }>) {
  const calls: Array<{ url: string; signal?: AbortSignal }> = []
  const transport: GitHubTransport = {
    root: ROOT,
    get: async (url, signal) => {
      calls.push({ url, signal })
      const page = pages[url]
      if (!page) throw new Error(`unexpected request ${url}`)
      return new Response(JSON.stringify(page.body), { status: 200, headers: page.link ? { link: page.link } : {} })
    },
  }
  return { transport, calls }
}

describe('parseNextLink', () => {
  it('finds the next page among other relations', () => {
    const header = `<${ROOT}/x?page=2>; rel="next", <${ROOT}/x?page=5>; rel="last"`
    expect(parseNextLink(header)).toBe(`${ROOT}/x?page=2`)
  })

  it('returns null on the last page or without a header', () => {
    expect(parseNextLink(`<${ROOT}/x?page=1>; rel="prev"`)).toBeNull()
    expect(parseNextLink(null)).toBeNull()
  })
})

describe('fetchJson', () => {
  it('appends the path to the transport root and passes the signal', async () => {
    const { transport, calls } = transportOf({ [`${ROOT}/a`]: { body: { ok: true } } })
    const controller = new AbortController()
    expect(await fetchJson(transport, '/a', controller.signal)).toEqual({ ok: true })
    expect(calls).toEqual([{ url: `${ROOT}/a`, signal: controller.signal }])
  })
})

describe('fetchAllPages', () => {
  it('follows next links under the root and collects every item', async () => {
    const { transport, calls } = transportOf({
      [`${ROOT}/list`]: { body: [1, 2], link: `<${ROOT}/list?page=2>; rel="next"` },
      [`${ROOT}/list?page=2`]: { body: [3] },
    })
    expect(await fetchAllPages<number>(transport, '/list', { maxPages: 5 })).toEqual({ items: [1, 2, 3], truncated: false })
    expect(calls.map((call) => call.url)).toEqual([`${ROOT}/list`, `${ROOT}/list?page=2`])
  })

  it('stops at maxPages and reports truncation', async () => {
    const { transport, calls } = transportOf({
      [`${ROOT}/list`]: { body: [1], link: `<${ROOT}/list?page=2>; rel="next"` },
    })
    expect(await fetchAllPages<number>(transport, '/list', { maxPages: 1 })).toEqual({ items: [1], truncated: true })
    expect(calls).toHaveLength(1)
  })

  it('does not follow a next link outside the root', async () => {
    const { transport, calls } = transportOf({
      [`${ROOT}/list`]: { body: [1], link: '<https://evil.test/list?page=2>; rel="next"' },
    })
    expect(await fetchAllPages<number>(transport, '/list', { maxPages: 5 })).toEqual({ items: [1], truncated: true })
    expect(calls).toHaveLength(1)
  })

  it('works with a relative root like the server proxy', async () => {
    const calls: string[] = []
    const transport: GitHubTransport = {
      root: 'api/github',
      get: async (url) => {
        calls.push(url)
        return new Response('[1]', { status: 200 })
      },
    }
    await fetchAllPages(transport, '/x', { maxPages: 2 })
    expect(calls).toEqual(['api/github/x'])
  })
})
