import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BODY_RENDER_LIMIT, RUN_TEXT_MAX } from '../markdown/bodyTree'
import type { ParsedBody } from '../markdown/bodyTree'
import { parseIssueBody } from '../markdown/issueBody'
import type { BodyParseOutcome } from '../markdown/parseBodyInWorker'
import { parseBodyInWorker } from '../markdown/parseBodyInWorker'
import { IssueBody } from './IssueBody'

vi.mock('../markdown/parseBodyInWorker', () => ({ parseBodyInWorker: vi.fn() }))

const ISSUE_URL = 'https://github.com/acme/widgets/issues/12'
const mocked = vi.mocked(parseBodyInWorker)

function parsesForReal() {
  mocked.mockImplementation(async (body, issueUrl) => ({
    status: 'parsed',
    parsed: parseIssueBody(body, issueUrl),
  }))
}

function renderBody(body: string) {
  return render(<IssueBody body={body} issueUrl={ISSUE_URL} />)
}

const plain = (container: HTMLElement) => container.querySelector('.issue-body__plain')

/** True when `first` comes before `second` in document order. */
const precedes = (first: Element | null, second: Element | null) =>
  Boolean(first && second && first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)

const notices = (container: HTMLElement) => [...container.querySelectorAll('.issue-body__notice')]

beforeEach(parsesForReal)
afterEach(() => mocked.mockReset())

describe('IssueBody', () => {
  it('starts no worker and says so for an empty or white-space body', () => {
    renderBody('  \n ')
    expect(screen.getByText('No description provided.')).toBeInTheDocument()
    expect(mocked).not.toHaveBeenCalled()
  })

  it('says so for a body that is only an HTML comment', async () => {
    renderBody('<!-- Please describe the bug -->')
    expect(await screen.findByText('No description provided.')).toBeInTheDocument()
  })

  it('shows a busy skeleton while the worker parses, then the body', async () => {
    let finish: (outcome: BodyParseOutcome) => void = () => {}
    mocked.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const { container } = renderBody('hello **there**')
    const busy = container.querySelector('.issue-body[aria-busy="true"]')
    expect(busy).not.toBeNull()
    expect(busy?.querySelector('.cds--skeleton__text')).not.toBeNull()

    await act(async () => finish({ status: 'parsed', parsed: parseIssueBody('hello **there**', ISSUE_URL) }))
    expect(container.querySelector('[aria-busy]')).toBeNull()
    expect(screen.getByText('there').tagName).toBe('STRONG')
  })

  it('aborts the signal on unmount and when the body changes', async () => {
    mocked.mockImplementation(() => new Promise(() => {}))
    const { rerender, unmount } = renderBody('one')
    const first = mocked.mock.calls[0][2].signal
    expect(first.aborted).toBe(false)

    rerender(<IssueBody body="two" issueUrl={ISSUE_URL} />)
    expect(first.aborted).toBe(true)
    const second = mocked.mock.calls[1][2].signal
    expect(second.aborted).toBe(false)

    unmount()
    expect(second.aborted).toBe(true)
  })

  it('never shows the tree of an older body', async () => {
    const resolvers: Record<string, (outcome: BodyParseOutcome) => void> = {}
    mocked.mockImplementation((body) => new Promise((resolve) => (resolvers[body] = resolve)))
    const { rerender, container } = renderBody('old')
    rerender(<IssueBody body="new" issueUrl={ISSUE_URL} />)
    await act(async () => resolvers.old({ status: 'parsed', parsed: parseIssueBody('old', ISSUE_URL) }))
    expect(screen.queryByText('old')).not.toBeInTheDocument()
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    await act(async () => resolvers.new({ status: 'parsed', parsed: parseIssueBody('new', ISSUE_URL) }))
    expect(await screen.findByText('new')).toBeInTheDocument()
  })

  describe('untrusted input', () => {
    const hostile = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '[x](javascript:alert(1))',
      '[y](data:text/html;base64,AAAA)',
      '![t](https://example.com/a.png)',
    ].join('\n\n')

    it('renders no script, img, onerror or javascript: and data: link', async () => {
      const { container } = renderBody(hostile)
      await screen.findByText('Image: t')
      expect(container.querySelector('script')).toBeNull()
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('[onerror]')).toBeNull()
      const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
      expect(hrefs.some((href) => /^(javascript|data):/i.test(href))).toBe(false)
      expect(container.textContent).toContain('[x](javascript:alert(1))')
      expect(container.textContent).toContain('[y](data:text/html;base64,AAAA)')
      expect(screen.getByText('Parts of this description are not shown.')).toBeInTheDocument()
    })

    it('turns an image into a link or a label, never an img', async () => {
      const { container } = renderBody(
        [
          '![t](https://example.com/a.png)',
          '![d](data:image/png;base64,AAAA)',
          '![Image](https://example.com/b.png)',
          'before <img src=x onerror=alert(1)> after',
          '[![build](https://img.shields.io/badge/x.svg)](https://ci.example.com/run/1)',
        ].join('\n\n'),
      )
      const link = await screen.findByRole('link', { name: 'Image: t' })
      expect(link).toHaveAttribute('href', 'https://example.com/a.png')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noreferrer')
      const plainImages = screen.getAllByRole('link', { name: 'Image' })
      expect(plainImages.map((anchor) => anchor.getAttribute('href'))).toEqual([
        'https://example.com/b.png',
        'https://github.com/acme/widgets/issues/x',
      ])
      expect(screen.getByText('Image: d').closest('a')).toBeNull()
      const build = screen.getByText('Image: build')
      expect(build.tagName).toBe('SPAN')
      expect(build.closest('a')).toHaveAttribute('href', 'https://ci.example.com/run/1')
      expect(container.querySelector('img')).toBeNull()
    })

    it('renders unsafe link forms as text with no anchor', async () => {
      const { container } = renderBody(
        [
          '<a href="javascript:alert(1)">click</a>',
          '[x](JaVaScRiPt:alert(1))',
          '<javascript:alert(1)>',
          '[a][r]\n\n[r]: javascript:alert(1)',
        ].join('\n\n'),
      )
      await screen.findByText(/click/)
      expect(screen.getByText(/click/).closest('a')).toBeNull()
      expect(container.querySelector('a')).toBeNull()
      const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
      expect(hrefs.some((href) => /^javascript:/i.test(href))).toBe(false)
    })

    it('renders a details element as a bold summary followed by the paragraph', async () => {
      const { container } = renderBody('<details><summary>Logs</summary>\n\nstack\n\n</details>')
      const summary = await screen.findByText('Logs')
      expect(summary.tagName).toBe('STRONG')
      expect(container.querySelector('details')).toBeNull()
      expect(summary.parentElement?.nextElementSibling).toHaveTextContent('stack')
      expect(summary.parentElement?.nextElementSibling?.tagName).toBe('P')
    })

    it('resolves fragment and protocol-relative links', async () => {
      renderBody('[top](#top) [p](//evil.example/x)')
      expect(await screen.findByRole('link', { name: 'top' })).toHaveAttribute(
        'href',
        'https://github.com/acme/widgets/issues/12#top',
      )
      expect(screen.getByRole('link', { name: 'p' })).toHaveAttribute('href', 'https://evil.example/x')
    })

    it('opens links in a new tab with rel=noreferrer and resolves relative ones', async () => {
      renderBody('[docs](../wiki/Install) [mail](mailto:a@b.c) [f](ftp://example.com/file)')
      const docs = await screen.findByRole('link', { name: 'docs' })
      expect(docs).toHaveAttribute('href', 'https://github.com/acme/widgets/wiki/Install')
      expect(docs).toHaveAttribute('rel', 'noreferrer')
      expect(screen.getByRole('link', { name: 'mail' })).toHaveAttribute('href', 'mailto:a@b.c')
      expect(screen.queryByRole('link', { name: 'f' })).not.toBeInTheDocument()
    })
  })

  describe('formatting', () => {
    it('renders blocks: headings one level down, lists, quotes, code, rules and tables', async () => {
      const { container } = renderBody(
        [
          '# Title',
          '###### Deep',
          '> quoted',
          '3. three\n4. four',
          '- a\n- b',
          '```\ncode here\n```',
          '---',
          '| a | b |\n| - | :-: |\n| 1 | 2 |',
          'some `inline` and *em* and ~~gone~~',
        ].join('\n\n'),
      )
      await screen.findByRole('heading', { level: 3, name: 'Title' })
      expect(screen.getByRole('heading', { level: 6, name: 'Deep' })).toBeInTheDocument()
      expect(container.querySelector('blockquote')).toHaveTextContent('quoted')
      expect(container.querySelector('ol')).toHaveAttribute('start', '3')
      expect(container.querySelectorAll('ul > li')).toHaveLength(2)
      expect(container.querySelector('pre.issue-body__code code')).toHaveTextContent('code here')
      expect(container.querySelector('hr')).not.toBeNull()
      expect(container.querySelectorAll('th')).toHaveLength(2)
      expect(container.querySelectorAll('tbody td')[1]).toHaveStyle({ textAlign: 'center' })
      expect(container.querySelector('code:not(pre code)')).toHaveTextContent('inline')
      expect(container.querySelector('em')).toHaveTextContent('em')
      expect(container.querySelector('del')).toHaveTextContent('gone')
    })

    it('puts the task icon inside the first paragraph of a tight task item', async () => {
      const { container } = renderBody('- [ ] todo\n- [x] done')
      const open = await screen.findByLabelText('Not done')
      expect(open.closest('p.issue-body__tight')).toHaveTextContent('todo')
      expect(screen.getByLabelText('Done').closest('li')).toHaveClass('issue-body__task')
      expect(container.querySelectorAll('li')).toHaveLength(2)
    })

    it('keeps the paragraphs of a tight item on separate lines', async () => {
      const { container } = renderBody('- a\n  <!-- c -->\n  b')
      await waitFor(() => expect(container.querySelectorAll('li p.issue-body__tight')).toHaveLength(2))
    })

    it('splits a long paragraph, heading, cell and code block into runs of at most 2,048 units', async () => {
      const long = 'abאב'.repeat(3000)
      const { container } = renderBody(
        [long, `# ${long}`, `| h |\n| - |\n| ${long} |`, '```\n' + long + '\n```'].join('\n\n'),
      )
      await waitFor(() => expect(container.querySelector('.issue-body__run')).not.toBeNull())
      for (const selector of ['p', 'h3', 'td', 'pre code']) {
        const runs = container.querySelectorAll(`${selector} > .issue-body__run`)
        expect(runs.length, selector).toBeGreaterThan(1)
        for (const run of runs) expect(run.textContent!.length).toBeLessThanOrEqual(RUN_TEXT_MAX)
      }
    })
  })

  describe('notices', () => {
    it('puts the truncation, omitted-HTML and tables notices before the formatted body', async () => {
      const parsed: ParsedBody = {
        blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'start' }] }],
        omittedHtml: true,
        truncated: true,
        tablesAsText: true,
      }
      mocked.mockResolvedValue({ status: 'parsed', parsed })
      const { container } = renderBody('start')
      const text = await screen.findByText('start')
      expect(notices(container)).toHaveLength(3)
      for (const notice of notices(container)) expect(precedes(notice, text)).toBe(true)
    })

    it('puts the tables-as-text notice before the text', async () => {
      const table = ['|' + 'a|'.repeat(300), '|' + '-|'.repeat(300), ...Array(230).fill('|b')].join('\n')
      const { container } = renderBody(table)
      await screen.findByText('Tables in this description are shown as plain text.')
      const text = container.querySelector('.issue-body > :not(.issue-body__notice)')
      expect(text).not.toBeNull()
      expect(precedes(notices(container)[0], text)).toBe(true)
    })

    it.each(['timed-out', 'failed'] as const)(
      'puts the notices before the plain text when the outcome is %s',
      async (status) => {
        mocked.mockResolvedValue({ status })
        const { container } = renderBody('x'.repeat(BODY_RENDER_LIMIT + 5))
        await screen.findByText('This description is shown as plain text.')
        expect(notices(container)).toHaveLength(2)
        for (const notice of notices(container)) expect(precedes(notice, plain(container))).toBe(true)
      },
    )

    it('puts the notice before the plain text when rendering throws', async () => {
      const broken = {
        blocks: [{ type: 'mystery' }],
        omittedHtml: false,
        truncated: false,
        tablesAsText: false,
      } as unknown as ParsedBody
      mocked.mockResolvedValue({ status: 'parsed', parsed: broken })
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { container } = renderBody('the body text')
      await screen.findByText(/Urutau could not format it\./)
      expect(precedes(notices(container)[0], plain(container))).toBe(true)
      error.mockRestore()
    })

    it('gives every focusable scroll container a region role and a name', async () => {
      const { container } = renderBody('```\ncode\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |')
      await screen.findByText('code')
      const focusable = [...container.querySelectorAll('.issue-body [tabindex="0"]')]
      expect(focusable.map((element) => element.getAttribute('aria-label'))).toEqual(['Code block', 'Table'])
      for (const element of focusable) expect(element).toHaveAttribute('role', 'region')
      expect(screen.getByRole('region', { name: 'Code block' })).toBe(focusable[0])
      expect(screen.getByRole('region', { name: 'Table' })).toBe(focusable[1])
    })

    it('says only the start is shown when the tree is truncated', async () => {
      const parsed: ParsedBody = {
        blocks: [{ type: 'paragraph', children: [{ type: 'text', text: 'start' }] }],
        omittedHtml: false,
        truncated: true,
        tablesAsText: false,
      }
      mocked.mockResolvedValue({ status: 'parsed', parsed })
      renderBody('start')
      expect(await screen.findByText('Only the start of this description is shown.')).toBeInTheDocument()
      expect(screen.getByText('Open the issue on GitHub to read all of it.')).toBeInTheDocument()
    })

    it('says tables are shown as text', async () => {
      const table = ['|' + 'a|'.repeat(300), '|' + '-|'.repeat(300), ...Array(230).fill('|b')].join('\n')
      const { container } = renderBody(table)
      expect(await screen.findByText('Tables in this description are shown as plain text.')).toBeInTheDocument()
      expect(container.querySelector('table')).toBeNull()
    })

    it.each([
      ['timed-out', 'Formatting it took too long. Open the issue on GitHub to see it formatted.'],
      ['failed', 'Urutau could not format it. Open the issue on GitHub to see it formatted.'],
    ] as const)('shows the plain-text view when the outcome is %s', async (status, subtitle) => {
      mocked.mockResolvedValue({ status })
      const { container } = renderBody('# not **formatted**\nsecond line')
      expect(await screen.findByText('This description is shown as plain text.')).toBeInTheDocument()
      expect(screen.getByText(subtitle)).toBeInTheDocument()
      expect(plain(container)?.textContent).toBe('# not **formatted**\nsecond line')
      expect(container.querySelector('strong')).toBeNull()
    })

    it('cuts the plain-text view and says so, in runs of at most 2,048 units', async () => {
      mocked.mockResolvedValue({ status: 'timed-out' })
      const body = 'x'.repeat(BODY_RENDER_LIMIT + 500)
      const { container } = renderBody(body)
      await screen.findByText('Only the start of this description is shown.')
      expect(plain(container)?.textContent).toBe('x'.repeat(BODY_RENDER_LIMIT))
      const runs = container.querySelectorAll('.issue-body__plain > .issue-body__run')
      expect(runs.length).toBe(BODY_RENDER_LIMIT / RUN_TEXT_MAX)
      for (const run of runs) expect(run.textContent!.length).toBeLessThanOrEqual(RUN_TEXT_MAX)
    })

    it('shows the plain-text view when rendering throws, and keeps its surroundings', async () => {
      const broken = {
        blocks: [{ type: 'mystery' }],
        omittedHtml: false,
        truncated: false,
        tablesAsText: false,
      } as unknown as ParsedBody
      mocked.mockResolvedValue({ status: 'parsed', parsed: broken })
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { container } = render(
        <main>
          <h2>Around</h2>
          <IssueBody body="the body text" issueUrl={ISSUE_URL} />
        </main>,
      )
      expect(await screen.findByText(/Urutau could not format it\./)).toBeInTheDocument()
      expect(plain(container)?.textContent).toBe('the body text')
      expect(screen.getByRole('heading', { name: 'Around' })).toBeInTheDocument()
      error.mockRestore()
    })

    it('renders nothing for an aborted outcome', async () => {
      mocked.mockResolvedValue({ status: 'aborted' })
      const { container } = renderBody('text')
      await waitFor(() => expect(container.querySelector('[aria-busy]')).toBeNull())
      expect(container).toBeEmptyDOMElement()
    })
  })
})
