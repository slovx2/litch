import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AgentSession,
  ExtensionUIContext,
  InlineExtension,
} from '@earendil-works/pi-coding-agent'
import { ProtocolError } from '../../shared/src/protocol-contract.mjs'
import type { ToolCallAsk, ToolCallBlock } from './approvals.mjs'
import { type ClientTool, clientToolContent, clientTools } from './dynamic-tools.mjs'
import { sessionDirectory } from './native-files.mjs'
import {
  builtInExtensions,
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from './sdk.mjs'
import type { PiThread } from './store.mjs'

export interface SessionHost {
  ui: ExtensionUIContext
  emit(event: any): void
  tool(tool: ClientTool, args: unknown, id: string, signal?: AbortSignal): Promise<any>
  /** 工具执行之前问用户（approvals.mts）。没打开审批时不给这一项，Pi 那边就不挂这道钩子 */
  approve?: (ask: ToolCallAsk) => Promise<ToolCallBlock | undefined>
}
export interface LiveSession {
  session: AgentSession
  loader: DefaultResourceLoader
  waitForExtensionInputs(): Promise<void>
  hasPendingInputs(): boolean
  dispose(): Promise<void>
  /** 手动压缩时由入口挂上（compaction.mts）：Pi 定了要压、动手之前调它 */
  compacting?: () => void
}

// 审批的钩子作为一个内联扩展交给 Pi，这是它在扩展清单里的名字和路径。
const APPROVAL_EXTENSION = 'codex-harness-adapter-approvals'
const APPROVAL_PATH = `<inline:${APPROVAL_EXTENSION}>`
// 压缩之前的事件也经一个内联扩展接：Pi 判断会话太小、不用压时直接报错，不发这个事件。
const COMPACTION_EXTENSION = 'codex-harness-adapter-compaction'

// prepared 是调用方已经建好的会话（分叉、临时会话）；省略时按线程记录打开或新建原生会话文件。
// 临时会话只在内存里，由调用方建好交进来（PiServer.open 守着：没交的临时会话不在这里新建）。
export async function openSession(
  thread: PiThread,
  host: SessionHost,
  prepared?: SessionManager,
): Promise<LiveSession> {
  const agentDir = getAgentDir()
  const settingsManager = SettingsManager.create(thread.cwd, agentDir)
  const eventBus = createEventBus()
  for (const kind of [
    'created',
    'started',
    'completed',
    'failed',
    'steered',
    'resumed',
    'resuming',
  ])
    eventBus.on(`subagents:${kind}`, (data) => host.emit({ type: 'subagent', kind, data }))
  const planPath = fileURLToPath(
    new URL('./dist/index.ts', import.meta.resolve('@narumitw/pi-plan-mode/package.json')),
  )
  const subagentPath = fileURLToPath(
    new URL('../index.ts', import.meta.resolve('@gotgenes/pi-subagents')),
  )
  const managed = [planPath, subagentPath]
  // 随适配器分发的插件注册的工具名，每次装载扩展时重填；审批的钩子靠它认这些工具。
  const managedTools = new Set<string>()
  const approve = host.approve
  // Pi 的 tool_call 事件在工具执行之前触发，处理函数可以一直等，返回 block 就不执行、理由交给模型。
  // 它覆盖内置工具、扩展工具、MCP 工具，以及工具经 executeTool 调的别的工具；子代理的子会话是插件
  // 另建的，装载不到这个内联扩展，所以子代理里的操作不经过这里。
  const approvals: InlineExtension[] = approve
    ? [
        {
          name: APPROVAL_EXTENSION,
          hidden: true,
          factory(pi) {
            pi.on('tool_call', (event, context) => {
              const info = pi.getAllTools().find((tool) => tool.name === event.toolName)
              return approve({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                input: event.input as Record<string, unknown>,
                source: info?.sourceInfo.path ?? null,
                annotations: info?.annotations,
                managed: managedTools.has(event.toolName),
                signal: context.signal,
              })
            })
          },
        },
      ]
    : []
  // 处理函数什么都不返回，不影响压不压、怎么压；自动压缩时入口没挂 compacting，什么都不做。
  let live: LiveSession | undefined
  const compaction: InlineExtension = {
    name: COMPACTION_EXTENSION,
    hidden: true,
    factory(pi) {
      pi.on('session_before_compact', () => {
        live?.compacting?.()
      })
    },
  }
  const loader = new DefaultResourceLoader({
    cwd: thread.cwd,
    agentDir,
    settingsManager,
    eventBus,
    additionalExtensionPaths: managed,
    extensionFactories: [...builtInExtensions, compaction, ...approvals],
    extensionsOverride(base) {
      const preferred = base.extensions.filter((e) =>
        managed.some((p) => e.path === p || e.resolvedPath === p),
      )
      const tools = new Set(preferred.flatMap((e) => [...e.tools.keys()]))
      managedTools.clear()
      for (const name of tools) managedTools.add(name)
      // 审批的钩子排在最后：处理函数按扩展的次序跑，别的扩展（比如计划模式）先拦下的调用就不用再问用户。
      const asking = base.extensions.filter((e) => e.path === APPROVAL_PATH)
      const commands = new Set(preferred.flatMap((e) => [...e.commands.keys()]))
      const flags = new Set(preferred.flatMap((e) => [...e.flags.keys()]))
      const overridden = base.extensions.filter(
        (e) =>
          !preferred.includes(e) &&
          ([...e.tools.keys()].some((n) => tools.has(n)) ||
            [...e.commands.keys()].some((n) => commands.has(n))),
      )
      // 只消除由管理插件优先级解决的重复注册诊断，其他加载错误仍然失败。
      const errors = base.errors.filter((e) => {
        const match = /^(Tool|Flag) "(?:--)?([^"]+)" conflicts with (.+)$/.exec(e.error)
        if (!match || !(match[1] === 'Tool' ? tools : flags).has(match[2]!)) return true
        return !overridden.some((x) => x.path === e.path || x.path === match[3])
      })
      return {
        ...base,
        errors,
        extensions: [
          ...preferred,
          ...base.extensions.filter(
            (e) => !preferred.includes(e) && !overridden.includes(e) && !asking.includes(e),
          ),
          ...asking,
        ],
      }
    },
  })
  await loader.reload()
  const errors = loader.getExtensions().errors
  if (errors.length) throw new Error(`Pi 扩展加载失败: ${errors.map((e) => e.error).join('; ')}`)
  const restoring = Boolean(thread.path && existsSync(thread.path))
  const manager =
    prepared ??
    (restoring
      ? SessionManager.open(thread.path!, sessionDirectory(thread.cwd), thread.cwd)
      : SessionManager.create(thread.cwd, sessionDirectory(thread.cwd)))
  const { session } = await createAgentSession({
    cwd: thread.cwd,
    agentDir,
    settingsManager,
    sessionManager: manager,
    resourceLoader: loader,
    customTools: clientTools(thread.dynamicTools).map((tool) => ({
      name: tool.piName,
      label: tool.name,
      description: `[${tool.namespace ?? 'functions'}.${tool.name}] ${tool.description ?? ''}`,
      parameters: tool.inputSchema as any,
      async execute(id: string, args: unknown, signal?: AbortSignal) {
        const result = await host.tool(tool, args, id, signal)
        return { content: clientToolContent(result), details: result }
      },
    })),
  })
  session.subscribe(host.emit)
  // 官方扩展 sendUserMessage 是 fire-and-forget。跟踪公开方法的原始 Promise，
  // 既等待真实提交（含异步 input hooks），也能识别只通知、未提交的 Plan 命令。
  const pendingInputs = new Set<Promise<void>>()
  const trackInput = (pending: Promise<void>): Promise<void> => {
    pendingInputs.add(pending)
    void pending
      .finally(() => {
        pendingInputs.delete(pending)
        host.emit({ type: 'adapter_idle' })
      })
      .catch(() => {})
    return pending
  }
  const sendUserMessage = session.sendUserMessage.bind(session)
  session.sendUserMessage = (...args) => trackInput(sendUserMessage(...args))
  const sendCustomMessage = session.sendCustomMessage.bind(session)
  session.sendCustomMessage = (...args) => trackInput(sendCustomMessage(...args))
  const unavailable = async () => {
    throw new ProtocolError(-32601, '请通过客户端会话入口操作')
  }
  try {
    await session.bindExtensions({
      mode: 'rpc',
      uiContext: host.ui,
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: unavailable,
        fork: unavailable,
        navigateTree: (id, options) => session.navigateTree(id, options),
        switchSession: unavailable,
        reload: () => session.reload(),
      },
      onError: (error) => host.emit({ type: 'extension_error', error }),
    })
    if (thread.model && !restoring) {
      const available = session.modelRuntime.getModels()
      const model = available.find((m) => `${m.provider}/${m.id}` === thread.model)
      if (!model) throw new ProtocolError(-32602, `Pi 模型不可用: ${thread.model}`)
      await session.setModel(model)
    }
    if (thread.effort && !restoring) session.setThinkingLevel(thread.effort as any)
  } catch (error) {
    try {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
    } finally {
      session.dispose()
    }
    throw error
  }
  live = {
    session,
    loader,
    hasPendingInputs: () => pendingInputs.size > 0,
    async waitForExtensionInputs() {
      while (pendingInputs.size) await Promise.all([...pendingInputs])
    },
    async dispose() {
      session.clearQueue()
      await session.abort()
      // 先关闭旧扩展，再恢复外部写入者的叶节点；不能对同一扩展重复发 session_start。
      const file = session.sessionFile
      let externalLeaf: string | undefined
      if (file && existsSync(file)) {
        const entries = readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        const memory = session.sessionManager.getEntries()
        if (JSON.stringify(entries.slice(1)) !== JSON.stringify(memory)) {
          const ids = new Set(memory.map((entry) => entry.id))
          externalLeaf =
            entries.slice(1).findLast((entry) => entry.id && !ids.has(entry.id))?.id ??
            entries.at(-1)?.id
        }
      }
      try {
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
      } finally {
        if (file && externalLeaf) {
          session.sessionManager.setSessionFile(file)
          session.sessionManager.branch(externalLeaf)
          session.sessionManager.appendCustomEntry('codex-harness-adapter-external-resume', {})
        }
        session.dispose()
      }
    },
  }
  return live
}

export function planState(session: AgentSession): any {
  for (const entry of session.sessionManager.getBranch().toReversed())
    if (entry.type === 'custom' && entry.customType === 'plan-mode-state') return entry.data
  return { enabled: false }
}
