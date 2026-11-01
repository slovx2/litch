import { ConversationSearch, type SearchWorkerInput } from '@litch/core'
import { markdownSearchText } from './markdown.ts'

const create = () =>
  new ConversationSearch((parts) =>
    parts.map((part) => (part.markdown ? markdownSearchText(part.text) : part.text)).join('\n'),
  )
let index = create()
self.addEventListener('message', (event: MessageEvent<SearchWorkerInput>) => {
  const message = event.data
  if (message.type === 'reset') index = create()
  else if (message.type === 'update') index.update(message.sources, message.removed)
  else self.postMessage(index.query(message.query, message.revision, message.order))
})
