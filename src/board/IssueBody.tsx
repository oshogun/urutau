import { Checkbox, CheckboxChecked } from '@carbon/icons-react'
import { InlineNotification, Link, SkeletonText } from '@carbon/react'
import { Component, Fragment, useEffect, useState, type ReactNode } from 'react'
import { RUN_TEXT_MAX, cutBody, splitTextRuns } from '../markdown/bodyTree'
import type {
  BodyBlock,
  BodyInline,
  BodyListItem,
  BodyTableCell,
  BodyTableRow,
  ParsedBody,
} from '../markdown/bodyTree'
import { parseBodyInWorker } from '../markdown/parseBodyInWorker'
import type { BodyParseOutcome } from '../markdown/parseBodyInWorker'

export interface IssueBodyProps {
  /** `issue.body ?? ''`. */
  body: string
  /** `issue.url`: the base for relative links. */
  issueUrl: string
}

const EMPTY_TEXT = 'No description provided.'

const FAILURE_SUBTITLE = {
  'timed-out': 'Formatting it took too long. Open the issue on GitHub to see it formatted.',
  failed: 'Urutau could not format it. Open the issue on GitHub to see it formatted.',
} as const

function Notice({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <InlineNotification
      kind="info"
      lowContrast
      hideCloseButton
      className="issue-body__notice"
      title={title}
      subtitle={subtitle}
    />
  )
}

function TruncatedNotice() {
  return (
    <Notice
      title="Only the start of this description is shown."
      subtitle="Open the issue on GitHub to read all of it."
    />
  )
}

function TextRuns({ text }: { text: string }) {
  const parts = splitTextRuns(text, RUN_TEXT_MAX)
  if (parts.length === 1) return <>{parts[0]}</>
  return (
    <>
      {parts.map((part, index) => (
        <span key={index} className="issue-body__run">
          {part}
        </span>
      ))}
    </>
  )
}

/** The body as text, for when it cannot be formatted. */
function PlainBody({ body, reason }: { body: string; reason: keyof typeof FAILURE_SUBTITLE }) {
  const { text, cut } = cutBody(body)
  return (
    <div className="issue-body">
      <p className="issue-body__plain">
        <TextRuns text={text} />
      </p>
      <Notice title="This description is shown as plain text." subtitle={FAILURE_SUBTITLE[reason]} />
      {cut && <TruncatedNotice />}
    </div>
  )
}

function imageLabel(alt: string): string {
  return alt === '' || alt.toLowerCase() === 'image' ? 'Image' : `Image: ${alt}`
}

function renderInline(node: BodyInline, key: number): ReactNode {
  switch (node.type) {
    case 'text':
      return <Fragment key={key}>{node.text}</Fragment>
    case 'break':
      return <br key={key} />
    case 'code':
      return <code key={key}>{node.text}</code>
    case 'emphasis':
      return <em key={key}>{renderInlines(node.children)}</em>
    case 'strong':
      return <strong key={key}>{renderInlines(node.children)}</strong>
    case 'strikethrough':
      return <del key={key}>{renderInlines(node.children)}</del>
    case 'link':
      return (
        <Link key={key} href={node.href} inline target="_blank" rel="noreferrer">
          {renderInlines(node.children)}
        </Link>
      )
    case 'image':
      return node.href ? (
        <Link key={key} href={node.href} inline target="_blank" rel="noreferrer">
          {imageLabel(node.alt)}
        </Link>
      ) : (
        <span key={key}>{imageLabel(node.alt)}</span>
      )
    default:
      throw new Error(`Unknown inline node: ${(node as { type: string }).type}`)
  }
}

function renderInlines(nodes: BodyInline[]): ReactNode[] {
  return nodes.map(renderInline)
}

/** Renders the children of a paragraph, heading or cell; `lead` goes first, inside the first run. */
function renderRuns(nodes: BodyInline[], lead?: ReactNode): ReactNode {
  const runs: BodyInline[][] = [[]]
  for (const node of nodes) {
    if (node.type === 'split') runs.push([])
    else runs[runs.length - 1].push(node)
  }
  if (runs.length === 1) {
    return (
      <>
        {lead}
        {renderInlines(runs[0])}
      </>
    )
  }
  return runs.map((run, index) => (
    <span key={index} className="issue-body__run">
      {index === 0 && lead}
      {renderInlines(run)}
    </span>
  ))
}

function renderCell(cell: BodyTableCell, key: number, head: boolean): ReactNode {
  const Tag = head ? 'th' : 'td'
  return (
    <Tag key={key} style={cell.align ? { textAlign: cell.align } : undefined}>
      {renderRuns(cell.children)}
    </Tag>
  )
}

function renderRow(row: BodyTableRow, key: number, head: boolean): ReactNode {
  return <tr key={key}>{row.cells.map((cell, index) => renderCell(cell, index, head))}</tr>
}

function renderListItem(item: BodyListItem, key: number, tight: boolean): ReactNode {
  const icon =
    item.task === 'done' ? (
      <CheckboxChecked size={16} aria-label="Done" />
    ) : item.task === 'open' ? (
      <Checkbox size={16} aria-label="Not done" />
    ) : undefined
  const [first, ...rest] = item.children
  return (
    <li key={key} className={item.task ? 'issue-body__task' : undefined}>
      {first?.type === 'paragraph' && icon ? (
        <>
          {renderBlock(first, 0, tight, icon)}
          {rest.map((block, index) => renderBlock(block, index + 1, tight))}
        </>
      ) : (
        item.children.map((block, index) => renderBlock(block, index, tight))
      )}
    </li>
  )
}

const HEADINGS = ['h3', 'h4', 'h5', 'h6', 'h6', 'h6'] as const

function renderBlock(block: BodyBlock, key: number, tight = false, lead?: ReactNode): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return (
        <p key={key} className={tight ? 'issue-body__tight' : undefined}>
          {renderRuns(block.children, lead)}
        </p>
      )
    case 'heading': {
      const Heading = HEADINGS[block.level - 1]
      return <Heading key={key}>{renderRuns(block.children)}</Heading>
    }
    case 'blockquote':
      return <blockquote key={key}>{block.children.map((child, index) => renderBlock(child, index))}</blockquote>
    case 'list': {
      const items = block.items.map((item, index) => renderListItem(item, index, block.tight))
      return block.ordered ? (
        <ol key={key} start={block.start && block.start !== 1 ? block.start : undefined}>
          {items}
        </ol>
      ) : (
        <ul key={key}>{items}</ul>
      )
    }
    case 'code':
      return (
        <pre key={key} className="issue-body__code" tabIndex={0}>
          <code>
            <TextRuns text={block.text} />
          </code>
        </pre>
      )
    case 'rule':
      return <hr key={key} />
    case 'table':
      return (
        <div key={key} className="issue-body__table" tabIndex={0}>
          <table>
            {block.head.length > 0 && (
              <thead>{block.head.map((row, index) => renderRow(row, index, true))}</thead>
            )}
            <tbody>{block.body.map((row, index) => renderRow(row, index, false))}</tbody>
          </table>
        </div>
      )
    default:
      throw new Error(`Unknown block: ${(block as { type: string }).type}`)
  }
}

function ParsedView({ parsed }: { parsed: ParsedBody }) {
  if (parsed.blocks.length === 0 && !parsed.omittedHtml) {
    return <p className="issue-body__empty">{EMPTY_TEXT}</p>
  }
  return (
    <div className="issue-body">
      {parsed.blocks.map((block, index) => renderBlock(block, index))}
      {parsed.truncated && <TruncatedNotice />}
      {parsed.omittedHtml && (
        <Notice
          title="Parts of this description are not shown."
          subtitle="They use HTML that Urutau does not display. Open the issue on GitHub to see them."
        />
      )}
      {parsed.tablesAsText && (
        <Notice
          title="Tables in this description are shown as plain text."
          subtitle="They have more cells than Urutau displays. Open the issue on GitHub to see them as tables."
        />
      )}
    </div>
  )
}

interface Settled {
  body: string
  issueUrl: string
  outcome: BodyParseOutcome
}

/** Parses in a worker; returns the outcome only while it belongs to the current props. */
function useParsedBody(body: string, issueUrl: string): BodyParseOutcome | null {
  const [settled, setSettled] = useState<Settled | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void parseBodyInWorker(body, issueUrl, { signal: controller.signal }).then((outcome) => {
      if (!controller.signal.aborted) setSettled({ body, issueUrl, outcome })
    })
    return () => controller.abort()
  }, [body, issueUrl])
  return settled && settled.body === body && settled.issueUrl === issueUrl ? settled.outcome : null
}

function FormattedBody({ body, issueUrl }: IssueBodyProps) {
  const outcome = useParsedBody(body, issueUrl)
  if (!outcome) {
    return (
      <div className="issue-body" aria-busy="true">
        <SkeletonText paragraph lineCount={3} />
      </div>
    )
  }
  if (outcome.status === 'aborted') return null
  if (outcome.status !== 'parsed') return <PlainBody body={body} reason={outcome.status} />
  return <ParsedView parsed={outcome.parsed} />
}

interface BoundaryProps {
  body: string
  children: ReactNode
}

/** Shows the plain-text view when rendering the formatted body throws. Resets only when unmounted. */
class BodyBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? <PlainBody body={this.props.body} reason="failed" /> : this.props.children
  }
}

export function IssueBody({ body, issueUrl }: IssueBodyProps) {
  if (cutBody(body).text.trim() === '') return <p className="issue-body__empty">{EMPTY_TEXT}</p>
  return (
    <BodyBoundary body={body}>
      <FormattedBody body={body} issueUrl={issueUrl} />
    </BodyBoundary>
  )
}
