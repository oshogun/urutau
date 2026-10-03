/** Registry of tool calls in progress, so revoking a token or removing an integration stops its calls. */
import type { InflightCall, InflightRegistry, McpPrincipal } from './contract.ts'

interface Entry {
  principal: McpPrincipal
  controller: AbortController
}

export function createInflightRegistry(): InflightRegistry {
  const entries = new Set<Entry>()

  const abortWhere = (matches: (principal: McpPrincipal) => boolean): number => {
    let count = 0
    for (const entry of [...entries]) {
      if (!matches(entry.principal)) continue
      entry.controller.abort()
      count++
    }
    return count
  }

  return {
    begin(principal, parent): InflightCall {
      const controller = new AbortController()
      const entry: Entry = { principal, controller }
      const onParentAbort = () => controller.abort()
      if (parent?.aborted) controller.abort()
      else parent?.addEventListener('abort', onParentAbort, { once: true })
      entries.add(entry)
      return {
        signal: controller.signal,
        end() {
          entries.delete(entry)
          parent?.removeEventListener('abort', onParentAbort)
        },
      }
    },
    abortToken: (tokenId) => abortWhere((principal) => principal.tokenId === tokenId),
    abortIntegration: (userId) => abortWhere((principal) => principal.userId === userId),
    size: () => entries.size,
  }
}
