import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createTwoFilesPatch } from 'diff'
import type { DynamicToolSpec } from './client-tools.mjs'
import { answerContent, userQuestions } from './questions.mjs'

// OpenCode 的一个工具部件（part.type 为 tool）在协议里画成哪种条目，以及它跑完时怎么收尾。
// 实时（事件）和重读历史（消息列表）共用这一份，两边画出来的一样。
// 工具名照 OpenCode 1.18 的内置工具：bash、read、glob、grep、edit、write、apply_patch、task、webfetch、
// websearch、codesearch、todowrite、question、skill、lsp 等；MCP 工具名是“服务名_工具名”。

/** 待办工具不画成条目：它们的内容走 turn/plan/updated（todo.updated 事件），和上游的 update_plan 一样 */
export const PLAN_TOOLS = new Set(['todowrite', 'todoread'])
const FILE_TOOLS = new Set(['edit', 'write', 'apply_patch', 'patch', 'multiedit'])

// OpenCode 给的统一 diff 开头带 `Index:` 和一行等号（jsdiff 的格式），协议里的 diff 从 ---/+++ 开始。
export function cleanDiff(diff: string): string {
  return diff.replace(/^Index: [^\n]*\n=+\n/, '')
}

// 回合差异里的一个文件（用户消息 summary.diffs 的一项）改写成 git diff 的样子，和别的引擎发的回合差异一致：
// 头两行换成 a/ b/ 前缀的相对路径，新建、删除的文件一边是 /dev/null。
export function gitStyleDiff(entry: any): string {
  const file = String(entry?.file ?? '')
  const patch = String(entry?.patch ?? '')
  const start = patch.search(/^@@/m)
  if (!file || start < 0) return ''
  const hunks = patch.slice(start)
  const added = entry.status === 'added' || /^@@ -0,0 /.test(hunks)
  const deleted = entry.status === 'deleted' || /^@@ -\d+(,\d+)? \+0,0 @@/.test(hunks)
  return [
    `diff --git a/${file} b/${file}`,
    ...(added ? ['new file mode 100644'] : deleted ? ['deleted file mode 100644'] : []),
    added ? '--- /dev/null' : `--- a/${file}`,
    deleted ? '+++ /dev/null' : `+++ b/${file}`,
    hunks.replace(/\n$/, ''),
  ].join('\n')
}

const absolute = (path: string, cwd: string) => (isAbsolute(path) ? path : join(cwd, path))

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// 新加的文件的 diff 就是完整内容（客户端按行计为新增），和原生 codex、Claude 入口一样；改动是统一 diff。
const added = (path: string, content: string) => ({ path, kind: { type: 'add' }, diff: content })
const updated = (path: string, diff: string, movePath: string | null = null) => ({
  path,
  kind: { type: 'update', move_path: movePath },
  diff: cleanDiff(diff),
})

/** 补丁里 + 开头的行拼回文件内容（apply_patch 新建文件时用） */
function addedContent(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n')
}

/**
 * 文件改动条目的 changes。来源按可信的先后：跑完时的 metadata（edit 的 diff、apply_patch 的 files、
 * write 的 exists）> 审批时 OpenCode 给的 diff（approvalDiff）> 照参数先算的一份（工具刚开始跑时，
 * edit 用新旧片段，write 读一下文件现在的内容）。write 没有审批时 OpenCode 不给 diff，
 * 跑完才知道原来有没有这个文件，改动的 diff 只能是开始跑时读到的那一份。
 */
export function fileChanges(
  part: any,
  cwd: string,
  approvalDiff: string | null,
  previous: any[] = [],
): any[] {
  const state = part.state ?? {}
  const input = state.input ?? {}
  const meta = state.metadata ?? {}
  const tool = String(part.tool)
  if (tool === 'apply_patch' || tool === 'patch') {
    const files: any[] = Array.isArray(meta.files) ? meta.files : []
    if (!files.length) return previous
    return files.map((file) => {
      const path = String(file.filePath ?? file.relativePath ?? '')
      if (file.type === 'add') return added(path, addedContent(String(file.patch ?? '')))
      if (file.type === 'delete') return { path, kind: { type: 'delete' }, diff: '' }
      return updated(path, String(file.patch ?? ''), file.movePath ? String(file.movePath) : null)
    })
  }
  const path = absolute(String(input.filePath ?? meta.filepath ?? ''), cwd)
  if (tool === 'write') {
    const content = String(input.content ?? '')
    if (meta.exists === false) return [added(path, content)]
    if (approvalDiff) return [updated(path, approvalDiff)]
    return previous.length ? previous : [added(path, content)]
  }
  // edit（以及别的改单个文件的工具）
  const diff = typeof meta.diff === 'string' && meta.diff ? meta.diff : approvalDiff
  if (diff) return [updated(path, diff)]
  if (previous.length) return previous
  return [
    updated(
      path,
      createTwoFilesPatch(path, path, String(input.oldString ?? ''), String(input.newString ?? '')),
    ),
  ]
}

// write 开始跑时还没写（或者刚写完）：先读一下文件，没有的算新加，有的和要写的内容比一比。
function writeStart(part: any, cwd: string): any[] {
  const input = part.state?.input ?? {}
  const path = absolute(String(input.filePath ?? ''), cwd)
  const content = String(input.content ?? '')
  const before = readText(path)
  if (before === null) return [added(path, content)]
  return [updated(path, before === content ? '' : createTwoFilesPatch(path, path, before, content))]
}

/** MCP 工具名（服务名_工具名）拆成服务和工具；不是已知 MCP 服务的工具算 OpenCode 自带的 */
function mcpRef(name: string, servers: readonly string[]): { server: string; tool: string } | null {
  const server = [...servers]
    .sort((a, b) => b.length - a.length)
    .find((candidate) => name.startsWith(`${candidate.replace(/[^a-zA-Z0-9_-]/g, '_')}_`))
  if (!server) return null
  return { server, tool: name.slice(server.replace(/[^a-zA-Z0-9_-]/g, '_').length + 1) }
}

export interface ToolContext {
  /** 部件所在的会话 */
  threadId: string
  /** 会话的动态工具（经适配器的 MCP 服务交给 OpenCode 的），不是的返回 null */
  dynamicTool(name: string): DynamicToolSpec | null
}

/** 子代理（task）调用的子会话号：OpenCode 建好子会话后写在部件的 metadata 里 */
const childSession = (part: any): string | null =>
  typeof part.state?.metadata?.sessionId === 'string' ? part.state.metadata.sessionId : null

/** 工具部件第一次能画时（不再是 pending：参数齐了）建条目；待办工具返回 null */
export function toolItem(
  part: any,
  cwd: string,
  mcpServers: readonly string[],
  context: ToolContext,
): any | null {
  const tool = String(part.tool)
  if (PLAN_TOOLS.has(tool)) return null
  const id = String(part.id)
  const input = part.state?.input ?? {}
  // 动态工具（含 Litch 的客户端工具）：画成上游的动态工具条目，和原生 codex、Claude、Pi 入口一样
  const dynamic = context.dynamicTool(tool)
  if (dynamic)
    return {
      type: 'dynamicToolCall',
      id,
      namespace: dynamic.namespace,
      tool: dynamic.tool,
      arguments: input,
      status: 'inProgress',
      contentItems: null,
      success: null,
      durationMs: null,
    }
  // 子代理：OpenCode 的 task 每次调用建（或者接着用）一个子会话，画成上游派子代理的条目，指向子线程
  if (tool === 'task') {
    const child = childSession(part)
    const model = part.state?.metadata?.model
    return {
      type: 'collabAgentToolCall',
      id,
      tool: 'spawnAgent',
      status: 'inProgress',
      senderThreadId: context.threadId,
      receiverThreadIds: child ? [child] : [],
      prompt: typeof input.prompt === 'string' ? input.prompt : null,
      model: model?.providerID && model?.modelID ? `${model.providerID}/${model.modelID}` : null,
      reasoningEffort: null,
      agentsStates: child ? { [child]: { status: 'running', message: null } } : {},
    }
  }
  if (tool === 'bash')
    return {
      type: 'commandExecution',
      id,
      command: String(input.command ?? ''),
      cwd: typeof input.workdir === 'string' && input.workdir ? absolute(input.workdir, cwd) : cwd,
      // 给一个非空的进程标识：官方桌面端把没有进程标识的命令当成“后台终端”，不显示它的输出。
      processId: `opencode:${part.callID ?? id}`,
      source: 'agent',
      status: 'inProgress',
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    }
  if (FILE_TOOLS.has(tool))
    return {
      type: 'fileChange',
      id,
      status: 'inProgress',
      changes: tool === 'write' ? writeStart(part, cwd) : fileChanges(part, cwd, null),
    }
  // 问用户的工具：一个动态工具条目，参数是发给客户端的那几道题（和 Claude、dsh 入口一样）。
  if (tool === 'question')
    return {
      type: 'dynamicToolCall',
      id,
      namespace: 'opencode',
      tool,
      arguments: { questions: userQuestions(input.questions) },
      status: 'inProgress',
      contentItems: null,
      success: null,
      durationMs: null,
    }
  if (tool === 'websearch' || tool === 'codesearch') {
    const query = String(input.query ?? '')
    return { type: 'webSearch', id, query, action: { type: 'search', query, queries: null } }
  }
  if (tool === 'webfetch') {
    const url = String(input.url ?? '')
    return { type: 'webSearch', id, query: url, action: { type: 'openPage', url: url || null } }
  }
  const mcp = mcpRef(tool, mcpServers)
  return {
    type: 'mcpToolCall',
    id,
    server: mcp?.server ?? 'opencode',
    tool: mcp?.tool ?? tool,
    status: 'inProgress',
    arguments: input,
    result: null,
    error: null,
    durationMs: null,
  }
}

const duration = (state: any): number | null =>
  typeof state?.time?.start === 'number' && typeof state?.time?.end === 'number'
    ? Math.max(0, Math.round(state.time.end - state.time.start))
    : null

/** 命令跑着时 OpenCode 每来一段输出就更新一次 metadata.output（全量快照，超长时只留末尾），这里取它 */
export const liveOutput = (part: any): string | null =>
  typeof part.state?.metadata?.output === 'string' ? part.state.metadata.output : null

/**
 * 工具部件到了终态（completed 或 error），把条目收尾。declined：这次调用的审批被用户拒绝了，
 * 照上游标成 declined（命令没跑，没有输出、退出码和时长），和 Claude、Pi、dsh 入口一样。
 */
export function finishTool(item: any, part: any, cwd: string, approvalDiff: string | null) {
  const state = part.state ?? {}
  const failed = state.status === 'error'
  const output = failed ? String(state.error ?? '') : String(state.output ?? '')
  if (item.type === 'commandExecution') {
    const meta = state.metadata ?? {}
    item.aggregatedOutput = typeof meta.output === 'string' ? meta.output : output
    item.exitCode = typeof meta.exit === 'number' ? meta.exit : failed ? null : 0
    item.durationMs = duration(state)
    // 非零退出不算工具出错，但条目照上游标失败
    item.status = failed || (item.exitCode !== null && item.exitCode !== 0) ? 'failed' : 'completed'
  } else if (item.type === 'fileChange') {
    item.changes = fileChanges(part, cwd, approvalDiff, item.changes)
    item.status = failed ? 'failed' : 'completed'
  } else if (item.type === 'dynamicToolCall' && item.namespace !== 'opencode') {
    // 动态工具：文字是 MCP 结果里的文字，图片 OpenCode 记成附件（data: 地址）
    item.success = !failed
    item.durationMs = duration(state)
    item.status = failed ? 'failed' : 'completed'
    const images = (Array.isArray(state.attachments) ? state.attachments : [])
      .filter(
        (file: any) => /^image\//.test(String(file?.mime)) && /^data:/.test(String(file?.url)),
      )
      .map((file: any) => ({ type: 'inputImage', imageUrl: String(file.url) }))
    item.contentItems = [
      ...(output || !images.length ? [{ type: 'inputText', text: output }] : []),
      ...(failed ? [] : images),
    ]
  } else if (item.type === 'collabAgentToolCall') {
    finishAgent(item, part, failed, output)
  } else if (item.type === 'dynamicToolCall') {
    item.success = !failed
    item.durationMs = duration(state)
    item.status = failed ? 'failed' : 'completed'
    item.contentItems = failed
      ? [{ type: 'inputText', text: output }]
      : answerContent(item.arguments.questions, state.metadata?.answers, output)
  } else if (item.type === 'mcpToolCall') {
    item.status = failed ? 'failed' : 'completed'
    item.durationMs = duration(state)
    item.result = failed
      ? null
      : { content: [{ type: 'text', text: output }], structuredContent: null, _meta: null }
    item.error = failed ? { message: output } : null
  }
}

// 用户在审批里拒掉的调用，OpenCode 记下的错误是这两句之一（不带说明的、带说明的）；回放时靠它认出“被拒”
export const rejectedByUser = (error: unknown): boolean =>
  typeof error === 'string' &&
  error.startsWith('The user rejected permission to use this specific tool call')

/** 审批被拒的调用照上游收尾（见 finishTool 的说明）；别的条目没有这种状态，留着失败 */
export function declineItem(item: any): void {
  if (item.type === 'commandExecution')
    Object.assign(item, {
      status: 'declined',
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    })
  else if (item.type === 'fileChange') item.status = 'declined'
}

// task 的输出是 `<task id="…" state="…"><task_result>…</task_result></task>` 这样的一段，取里面的结果
function taskResult(output: string): string {
  const match = /<task_result>([\s\S]*?)<\/task_result>/.exec(output)
  return (match?.[1] ?? output).trim()
}

/** 子代理条目收尾：子线程号到这时一定有了（没有的话补上），子代理的状态跟着工具的状态 */
function finishAgent(item: any, part: any, failed: boolean, output: string): void {
  const child = childSession(part)
  if (child && !item.receiverThreadIds.includes(child)) item.receiverThreadIds = [child]
  const aborted = failed && /abort/i.test(output)
  // 后台跑的（OpenCode 的实验开关）调用立刻返回，子代理还在跑
  const background = !failed && part.state?.metadata?.background === true
  item.status = aborted ? 'interrupted' : failed ? 'failed' : 'completed'
  const status = aborted ? 'interrupted' : failed ? 'errored' : background ? 'running' : 'completed'
  item.agentsStates = Object.fromEntries(
    item.receiverThreadIds.map((id: string) => [
      id,
      { status, message: background ? null : taskResult(output) || null },
    ]),
  )
}
