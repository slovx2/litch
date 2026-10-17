// ACP 的工具调用（tool_call、tool_call_update）怎么变成 Codex 的条目。
// ACP 不告诉我们工具叫什么，只给一个给人看的标题和一个大类（kind）：
//   execute                → commandExecution（命令）
//   edit、delete、move     → fileChange（改文件；内容里的 diff 就是改动）
//   别的（read、search、fetch、think、switch_mode、other）→ mcpToolCall，server 记成 harness 的标识，tool 是标题
// 条目一旦开始，种类就不再变（后来的更新改了 kind 也不换种类，只更新内容）。
import { createTwoFilesPatch } from 'diff'

export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined'

const FILE_KINDS = new Set(['edit', 'delete', 'move'])

/** ACP 的工具状态换成条目的状态；没给的算还在进行 */
export function itemStatus(status: unknown): ItemStatus {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  return 'inProgress'
}

/** 内容块里能当文字看的部分 */
export function blockText(block: any): string {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text') return String(block.text ?? '')
  if (block.type === 'resource_link')
    return `[${block.title ?? block.name ?? block.uri}](${block.uri})`
  if (block.type === 'resource' && typeof block.resource?.text === 'string')
    return block.resource.text
  return ''
}

/** 工具调用内容里的文字（type 为 content 的那几段），按段连起来 */
export function contentText(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .filter((entry: any) => entry?.type === 'content')
    .map((entry: any) => blockText(entry.content))
    .filter(Boolean)
    .join('\n')
}

/** 命令条目上的命令：agent 给的原始参数里有 command 就用它，没有就用标题 */
function commandOf(update: any): string {
  const raw = update.rawInput?.command ?? update.rawInput?.cmd
  if (Array.isArray(raw)) return raw.map(String).join(' ')
  if (typeof raw === 'string' && raw) return raw
  return String(update.title ?? '')
}

export function toolItem(id: string, update: any, cwd: string, server: string): any {
  const kind = String(update.kind ?? 'other')
  const status = itemStatus(update.status)
  if (kind === 'execute')
    return {
      type: 'commandExecution',
      id,
      command: commandOf(update),
      cwd: typeof update.rawInput?.cwd === 'string' ? update.rawInput.cwd : cwd,
      processId: null,
      source: 'agent',
      status,
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    }
  if (FILE_KINDS.has(kind)) return { type: 'fileChange', id, status, changes: [] }
  return {
    type: 'mcpToolCall',
    id,
    server,
    tool: String(update.title ?? kind),
    status,
    arguments: update.rawInput ?? {},
    result: null,
    error: null,
    durationMs: null,
  }
}

/** 一处改动：协议里 add 带文件的全文，delete 带原来的内容，update 带 unified diff */
export function fileChangeOf(
  path: string,
  oldText: string | null,
  newText: string,
  deleted = false,
): any {
  if (deleted) return { path, kind: { type: 'delete' }, diff: oldText ?? '' }
  if (oldText === null) return { path, kind: { type: 'add' }, diff: newText }
  return {
    path,
    kind: { type: 'update', move_path: null },
    diff: createTwoFilesPatch(path, path, oldText, newText),
  }
}

/** 工具内容里的 diff 段换成改动；同一个文件出现几次的，后来的为准 */
export function diffChanges(content: unknown, deleted: boolean): any[] {
  const changes = new Map<string, any>()
  for (const entry of Array.isArray(content) ? content : [])
    if (entry?.type === 'diff' && typeof entry.path === 'string')
      changes.set(
        entry.path,
        fileChangeOf(
          entry.path,
          typeof entry.oldText === 'string' ? entry.oldText : null,
          String(entry.newText ?? ''),
          deleted,
        ),
      )
  return [...changes.values()]
}

/** 工具内容里提到的终端（agent 用我们的终端跑命令时会把终端挂在调用上） */
export function terminalIds(content: unknown): string[] {
  return (Array.isArray(content) ? content : [])
    .filter((entry: any) => entry?.type === 'terminal' && typeof entry.terminalId === 'string')
    .map((entry: any) => entry.terminalId)
}

/** 命令的退出码：agent 的原始输出里有就用，没有就按成败算 */
export function exitCodeOf(rawOutput: any, failed: boolean): number {
  for (const value of [rawOutput?.exitCode, rawOutput?.exit_code, rawOutput?.metadata?.exit])
    if (typeof value === 'number' && Number.isInteger(value)) return value
  return failed ? 1 : 0
}

/** 原始输出里能当命令输出的文字（agent 没在内容里给时用） */
export function rawOutputText(rawOutput: any): string {
  if (typeof rawOutput === 'string') return rawOutput
  for (const value of [rawOutput?.output, rawOutput?.stdout])
    if (typeof value === 'string') return value
  return ''
}

/** MCP 条目的结果：内容块换成文字段，原始输出是对象的放进结构化内容 */
export function mcpResult(update: any): any {
  const content = (Array.isArray(update.content) ? update.content : [])
    .filter((entry: any) => entry?.type === 'content')
    .map((entry: any) => ({ type: 'text', text: blockText(entry.content) }))
    .filter((entry: any) => entry.text)
  const raw = update.rawOutput
  return {
    content,
    structuredContent: raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null,
    _meta: null,
  }
}
