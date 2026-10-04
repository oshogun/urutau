import type { BodyWorkerMessage, BodyWorkerRequest } from './bodyTree.ts'
import { parseIssueBody } from './issueBody.ts'

self.addEventListener('message', (event: MessageEvent<BodyWorkerRequest>) => {
  const message: BodyWorkerMessage = {
    type: 'parsed',
    parsed: parseIssueBody(event.data.body, event.data.issueUrl),
  }
  self.postMessage(message)
})

const ready: BodyWorkerMessage = { type: 'ready' }
self.postMessage(ready)
