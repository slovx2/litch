// 模拟核心里“工具大结果”那一出用的两次工具调用（关键字见 mock-core.mts 的 HUGE_TOOLS）。
// 写成协议里的形状，交给真的投影（projection/items.mts）去投、去截：模拟的是对面，截的是真的那一套。
import type { ThreadItem } from '../../../protocol/src/index.mjs'

/** 第一次：MCP 工具导出一张表，结果是 20 MB 上下的文字，中间夹一张 2 MB 的图，最后一段是一句结语 */
export const DUMP_SERVER = 'db'
export const DUMP_TOOL = 'dump_table'
const DUMP_ROWS = 480_000
/** 导出的第 n 行。行里带着序号，看得出头尾留的是哪几行 */
export const dumpRow = (n: number): string =>
  `[${String(n).padStart(7, '0')}] event #${n} · user-${n % 211} · ok\n`
export const DUMP_END = '-- end of dump --'

/** 第二次：动态工具截一组图，结果是三千段文字和三千张小图交替 */
export const SHOTS_NAMESPACE = 'browser'
export const SHOTS_TOOL = 'capture_frames'
const SHOTS = 3000
/** 一张小图：内联的 PNG，内容是凑的 */
const FRAME = `data:image/png;base64,${'A'.repeat(400)}`

/** 导出的全文。不留着：模拟核心进程的内存也要量，投影截过之后它就该没了 */
const dumpText = (): string => {
  const rows: string[] = []
  for (let n = 1; n <= DUMP_ROWS; n++) rows.push(dumpRow(n))
  return rows.join('')
}

export function dumpCall(id: string, status: 'inProgress' | 'completed'): ThreadItem {
  return {
    type: 'mcpToolCall',
    id,
    server: DUMP_SERVER,
    tool: DUMP_TOOL,
    status,
    arguments: { table: 'events', limit: null },
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: true,
    result:
      status === 'completed'
        ? {
            content: [
              { type: 'text', text: dumpText() },
              { type: 'image', data: 'A'.repeat(2 * 1024 * 1024), mimeType: 'image/png' },
              { type: 'text', text: DUMP_END },
            ],
            structuredContent: null,
            _meta: null,
          }
        : null,
    error: null,
    durationMs: status === 'completed' ? 820 : null,
  }
}

export function shotsCall(id: string, status: 'inProgress' | 'completed'): ThreadItem {
  const contentItems: (
    | { type: 'inputText'; text: string }
    | { type: 'inputImage'; imageUrl: string }
  )[] = []
  if (status === 'completed') {
    for (let n = 1; n <= SHOTS; n++) {
      contentItems.push({ type: 'inputText', text: `frame ${n}` })
      contentItems.push({ type: 'inputImage', imageUrl: FRAME })
    }
  }
  return {
    type: 'dynamicToolCall',
    id,
    namespace: SHOTS_NAMESPACE,
    tool: SHOTS_TOOL,
    arguments: { url: 'http://localhost:5173/', frames: SHOTS },
    status,
    contentItems: status === 'completed' ? contentItems : null,
    success: status === 'completed' ? true : null,
    durationMs: status === 'completed' ? 410 : null,
  }
}
