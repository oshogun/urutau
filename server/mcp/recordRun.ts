/** record_run: validates what the schema cannot, calls the run store, and publishes the card-activity event. */
import { isTerminalStatus } from '../../src/domain/activity.ts'
import type { RunStatus, TriageRange, UncertaintyKind, UnverifiedItem } from '../../src/domain/types.ts'
import { RunStoreError, RUN_LIMITS, type RecordRunInput } from '../runs/types.ts'
import { cleanText } from './clean.ts'
import { ToolFailure, type McpPrincipal, type McpToolErrorCode, type RecordRunJson, type ToolDeps } from './contract.ts'

/** The tool's input after the zod schema accepted it. */
export interface RecordRunArgs {
  issue: number
  runId: string
  status: RunStatus
  triageRange?: TriageRange
  uncertaintyKind?: UncertaintyKind
  unverified?: { id: string; kind: UnverifiedItem['kind']; text: string }[]
  mergeShas?: string[]
  files?: string[]
  areas?: string[]
  observedBy?: string
  fixRounds?: number
  filesOmitted?: number
  costUsd?: number
  findings?: string
  probes?: { item: string; note?: string }[]
  withdrawn?: string[]
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length
}

/**
 * Records one run for the repository `repoKey`, which the caller already
 * checked against the integration's list. Changes nothing but the run tables:
 * no board save, no GitHub request.
 */
export async function recordRunTool(
  deps: Pick<ToolDeps, 'boards' | 'runs' | 'now' | 'log' | 'publishCardActivity'>,
  principal: McpPrincipal,
  signal: AbortSignal,
  repoKey: string,
  args: RecordRunArgs,
): Promise<RecordRunJson> {
  // A claim must be releasable by a person, and people release claims from the board.
  if (!isTerminalStatus(args.status) && (await deps.boards.get(repoKey)) === null) throw new ToolFailure('no-board')

  const probes = args.probes ?? []
  const withdrawn = args.withdrawn ?? []
  if (
    hasDuplicates((args.unverified ?? []).map((entry) => entry.id)) ||
    hasDuplicates(probes.map((probe) => probe.item)) ||
    hasDuplicates(withdrawn)
  ) {
    throw new ToolFailure('duplicate-item')
  }
  const probed = new Set(probes.map((probe) => probe.item))
  if (withdrawn.some((id) => probed.has(id))) throw new ToolFailure('probed-and-withdrawn')

  const unverified = args.unverified?.map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    text: cleanText(entry.text, RUN_LIMITS.itemTextMax),
  }))
  const cleanedProbes = probes.map((probe) => ({
    item: probe.item,
    note: probe.note === undefined ? null : cleanText(probe.note, RUN_LIMITS.noteMax),
  }))
  const findings = args.findings === undefined ? undefined : cleanText(args.findings, RUN_LIMITS.findingsMax)
  if (
    unverified?.some((entry) => entry.text === '') ||
    cleanedProbes.some((probe) => probe.note === '') ||
    findings === ''
  ) {
    throw new ToolFailure('invalid-text')
  }

  if (signal.aborted) throw new ToolFailure('call-stopped')

  const input: RecordRunInput = {
    repoKey,
    issue: args.issue,
    runId: args.runId,
    agentUserId: principal.userId,
    status: args.status,
    triageRange: args.triageRange,
    uncertaintyKind: args.uncertaintyKind,
    unverified,
    mergeShas: args.mergeShas,
    files: args.files,
    filesOmitted: args.filesOmitted,
    areas: args.areas,
    observedBy: args.observedBy,
    fixRounds: args.fixRounds,
    costUsd: args.costUsd === undefined ? undefined : Math.round(args.costUsd * 1e6) / 1e6,
    findings,
    probes: args.probes === undefined ? undefined : cleanedProbes,
    withdrawn: args.withdrawn,
  }

  let outcome
  try {
    outcome = await deps.runs.recordRun(input, deps.now())
  } catch (error) {
    if (error instanceof RunStoreError) {
      throw new ToolFailure(error.code as McpToolErrorCode, error.runStatus ? { runStatus: error.runStatus } : {})
    }
    throw error
  }

  if (outcome.notify) {
    try {
      deps.publishCardActivity({ repoKey, issue: args.issue, clientId: null })
    } catch {
      // The run is recorded; open boards catch up on their next refetch.
      deps.log.warn('card activity not published', { integration: principal.userId })
    }
  }

  return {
    repo: repoKey,
    issue: args.issue,
    runId: args.runId,
    status: outcome.status,
    created: outcome.created,
    statusChanged: outcome.statusChanged,
    claim: outcome.claim,
    unverifiedOpen: outcome.unverifiedOpen,
    probesApplied: outcome.probesApplied,
    probesSkipped: outcome.probesSkipped,
    withdrawnApplied: outcome.withdrawnApplied,
    withdrawnSkipped: outcome.withdrawnSkipped,
    notified: outcome.notify,
  }
}
