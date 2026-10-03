/** reorder_bucket. */
import { bucketNumbers, reorderBucket, resolveBuckets } from '../../src/domain/board.ts'
import { bucketIds } from './clean.ts'
import { MCP_LIMITS, ToolFailure, type McpPrincipal, type MoveDeps, type ReorderBucketJson } from './contract.ts'
import { onceRefresh, saveWithRetries, type Planner } from './move.ts'

export interface ReorderInput {
  repoKey: string
  /** As the client sent it (plain id or alias). */
  bucket: string
  order: number[]
  expectedVersion: number | null
}

export async function reorderBucketTool(
  deps: MoveDeps,
  principal: McpPrincipal,
  signal: AbortSignal,
  input: ReorderInput,
): Promise<ReorderBucketJson> {
  const planner: Planner<ReorderBucketJson> = async (stored, given) => {
    const ids = bucketIds(stored.board.buckets)
    const bucketId = ids.fromInput(input.bucket)
    if (bucketId === null) throw new ToolFailure('bucket-not-found')

    let snap = given
    const refresh = onceRefresh(deps, principal, signal, stored, () => snap, (fresh) => (snap = fresh))

    let list = bucketNumbers(resolveBuckets(snap.issues, stored.board), bucketId)
    const closedAndStale = (): boolean => {
      const stale = deps.now().getTime() - snap.fetchedAt > MCP_LIMITS.closedRefetchAgeMs
      return stale && input.order.some((n) => snap.issues.some((i) => i.number === n && i.state === 'closed'))
    }
    const maybeNew = input.order.some((n) => !list.includes(n) && n > snap.highestNumber)
    if (maybeNew || closedAndStale()) {
      await refresh()
      list = bucketNumbers(resolveBuckets(snap.issues, stored.board), bucketId)
    }

    const missing = input.order.find((n) => !list.includes(n))
    if (missing !== undefined) {
      throw new ToolFailure(snap.pullRequests.has(missing) ? 'is-pull-request' : 'card-not-in-bucket')
    }
    if (input.order.some((n) => snap.issues.some((i) => i.number === n && i.state === 'closed'))) {
      throw new ToolFailure('issue-closed')
    }

    const plan = reorderBucket(stored.board, snap.issues, bucketId, input.order)
    const bucket = ids.toOutput(bucketId)
    return {
      config: plan.config,
      bucketId,
      expected: plan.expected,
      changed: plan.changed,
      snapshot: snap,
      moved: input.order,
      unseenBeforeMoved: false,
      result: (saved, attempts) => ({
        repo: saved.repoKey,
        version: saved.version,
        bucket,
        order: plan.expected,
        attempts,
      }),
    }
  }

  const result = await saveWithRetries(deps, principal, signal, input.repoKey, input.expectedVersion, planner)
  deps.log.info('mcp reorder', {
    integration: principal.userId,
    tokenId: principal.tokenId,
    repo: result.repo,
    bucket: result.bucket,
    count: input.order.length,
    version: result.version,
  })
  return result
}
