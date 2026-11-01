import { ConversationSearch, type SearchWorkerInput, type SearchWorkerOutput } from '@litch/core'
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
  else self.postMessage(index.query(message.query, message.revision, message.order, message.anchor))
})
// 模块（含依赖）加载、求值完才走到这里；主线程等不到它就当作加载失败
self.postMessage({ type: 'ready' } satisfies SearchWorkerOutput)
