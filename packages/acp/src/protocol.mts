import { isAbsolute } from 'node:path'
import { gitDiffToRemote } from '../../shared/src/git-diff-remote.mjs'
import { applyNotificationOptOut } from '../../shared/src/notification-opt-out.mjs'
import { projectRequest } from '../../shared/src/project-rpc.mjs'
import {
  historyHeadCursors,
  ProtocolError,
  pageRecords,
  pageThreadItems,
  requiredString,
} from '../../shared/src/protocol-contract.mjs'
import { codexUserAgent, platformFamily, platformOs } from '../../shared/src/runtime-version.mjs'
import { PINNED_SECTION, PINNED_SECTION_ID } from '../../shared/src/thread-sections.mjs'
import type { RpcPeer } from '../../shared/src/types.mjs'
import {
  type Catalog,
  currentEffort,
  currentModel,
  efforts,
  models as modelChoices,
  planMode,
} from './catalog.mjs'
import { envelope, PROFILE, settings } from './envelope.mjs'
import type { AcpServer } from './server.mjs'
import { runtimeInfo, versions } from './versions.mjs'

// 声明里关掉的（插话、压缩、回退、删除等，见 declaration.mts）都落到这里：-32601
const unsupported = (s: AcpServer, method: string) =>
  new ProtocolError(-32601, `${s.agentId} 入口不支持 ${method}`)

// ACP 没有对应物的能力：明确答“不适用”（-32004），不报“方法不存在”，也不伪造成功。
const NOT_APPLICABLE: Record<string, string> = {
  'mcpServerStatus/list': 'ACP agent 的 MCP 服务由 agent 自己配置，协议里没有查询它们状态的方法',
  'app/installed': 'OpenAI 应用连接器是 Codex 专属能力',
  'plugin/installed': 'Codex 插件是 Codex 专属能力',
  'marketplace/add': 'Codex 插件市场是 Codex 专属能力',
}

/** agent 报的模型换成 Codex 的模型清单；还没见过 agent 报的（一个会话都没建过）是空的 */
function models(s: AcpServer): any[] {
  const catalog = s.latestCatalog()
  if (!catalog) return []
  const current = currentModel(catalog)
  const levels = efforts(catalog)
  const effort = currentEffort(catalog) ?? levels[0]?.value ?? 'none'
  const image = s.runtime.known?.image === true
  return modelChoices(catalog).map((choice) => ({
    id: choice.value,
    model: choice.value,
    displayName: choice.name,
    description: choice.description ?? choice.name,
    hidden: false,
    modelSpecialty: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: choice.value === current,
    supportedReasoningEfforts: levels.map((level) => ({
      reasoningEffort: level.value,
      description: level.description ?? level.name,
    })),
    defaultReasoningEffort: effort,
    inputModalities: image ? ['text', 'image'] : ['text'],
    supportsPersonality: false,
    upgrade: null,
    availabilityNux: null,
    upgradeInfo: null,
  }))
}

/** 斜杠命令当技能报：路径是个假的标识（客户端丢掉没有路径的技能），交给 agent 的只有名字 */
function skills(s: AcpServer, cwd: string): any[] {
  const opened = [...s.live.values()].find((live) => live.projection.thread.cwd === cwd)
  const commands: any[] = opened?.projection.commands ?? s.store.getMeta('commands', cwd) ?? []
  return commands
    .filter((command) => typeof command?.name === 'string' && command.name)
    .map((command) => ({
      name: command.name,
      description: String(command.description ?? ''),
      path: `acp://${s.agentId}/commands/${command.name}`,
      scope: 'system',
      enabled: true,
    }))
}

export async function dispatch(s: AcpServer, peer: RpcPeer, method: string, p: any): Promise<any> {
  if (method.startsWith('fs/')) return s.files.call(peer, method, p)
  if (method === 'command/exec' || method === 'process/spawn')
    return s.processes.start(peer, method === 'command/exec' ? 'command' : 'process', p)
  if (
    method.startsWith('command/exec/') ||
    ['process/writeStdin', 'process/resizePty', 'process/kill'].includes(method)
  )
    return s.processes.followup(
      peer,
      method.startsWith('command/') ? 'command' : 'process',
      /write|writeStdin/.test(method) ? 'write' : /resize/.test(method) ? 'resize' : 'kill',
      p,
    )
  if (method.startsWith('project/'))
    return projectRequest(
      s.projects,
      method,
      p,
      (projectId, changeType) => s.notify(null, 'project/changed', { projectId, changeType }),
      (threadId, projectId) => s.notify(threadId, 'thread/project/updated', { projectId }),
    )
  if (NOT_APPLICABLE[method])
    throw new ProtocolError(
      -32004,
      `${s.agentId} 运行时不适用此能力: ${method}（${NOT_APPLICABLE[method]}）`,
    )
  switch (method) {
    case 'initialize':
      applyNotificationOptOut(peer, p)
      return {
        userAgent: codexUserAgent(
          typeof p.clientInfo?.name === 'string' ? p.clientInfo.name : 'codex-app',
          typeof p.clientInfo?.version === 'string' ? p.clientInfo.version : 'unknown',
          versions.protocol,
          `codex-harness-adapter-${s.agentId}`,
        ),
        codexHome: process.env.CODEX_HOME ?? process.cwd(),
        platformFamily: platformFamily(),
        platformOs: platformOs(),
      }
    case 'runtime/info': {
      // 声明照 agent 的能力定：没握过手的先起来握一次；起不来的照保守的报（各项能力按没有算）
      const agent = await s.runtime.agent().catch(() => null)
      return runtimeInfo(s.agentId, agent?.caps ?? s.runtime.known)
    }
    case 'server/diagnostics':
      return {
        process: {
          id: process.pid,
          residentMemoryBytes: process.memoryUsage.rss(),
          physicalFootprintBytes: null,
        },
        gauges: [{ name: `${s.agentId}_adapter.loaded_sessions`, value: s.live.size }],
      }
    case 'currentTime/read':
      return { currentTime: new Date().toISOString() }
    case 'account/read':
      return { account: null, requiresOpenaiAuth: false }
    case 'getAuthStatus':
      return { authMethod: null, authToken: null, requiresOpenaiAuth: false }
    case 'account/rateLimits/read':
      return {
        rateLimits: {
          limitId: null,
          limitName: null,
          primary: null,
          secondary: null,
          credits: null,
          planType: null,
          rateLimitReachedType: null,
        },
        rateLimitsByLimitId: null,
      }
    case 'configRequirements/read':
      return { requirements: null }
    case 'modelProvider/capabilities/read':
      return { namespaceTools: false, imageGeneration: false, webSearch: false }
    case 'app/list':
    case 'hooks/list':
    case 'experimentalFeature/list':
      return { data: [], nextCursor: null }
    case 'experimentalFeature/enablement/set': {
      const { enablement } = p
      if (
        !enablement ||
        typeof enablement !== 'object' ||
        Array.isArray(enablement) ||
        Object.values(enablement).some((value) => typeof value !== 'boolean')
      )
        throw new ProtocolError(-32602, 'enablement 必须是布尔值映射')
      if (Object.keys(enablement).length)
        throw new ProtocolError(-32004, `${s.agentId} 运行时没有实验功能开关；未修改任何设置`)
      return { enablement: {} }
    }
    case 'plugin/list':
      return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }
    case 'plugin/share/list':
      return { data: [] }
    case 'externalAgentConfig/detect':
      return { items: [] }
    case 'permissionProfile/list':
      // 只有一档（declaration.mts），和 Pi 一样不列可选的档
      return { data: [], nextCursor: null }
    case 'collaborationMode/list': {
      const catalog = s.latestCatalog()
      const plan = catalog ? planMode(catalog) : null
      const mode = (name: string) => ({
        name,
        mode: name,
        model: null,
        reasoning_effort: null,
        developer_instructions: null,
      })
      return { data: [mode('default'), ...(plan ? [mode('plan')] : [])] }
    }
    case 'model/list':
      return { data: models(s), nextCursor: null }
    case 'config/read': {
      const catalog: Catalog | null = s.latestCatalog()
      const saved = s.store.getMeta('config', 'defaults') ?? {}
      return {
        config: {
          model: saved.model ?? (catalog ? currentModel(catalog) : null),
          model_provider: s.agentId,
          model_reasoning_effort:
            saved.model_reasoning_effort ?? (catalog ? currentEffort(catalog) : null),
          approval_policy: 'on-request',
          sandbox_mode: 'danger-full-access',
          default_permissions: PROFILE,
          features: {},
          model_providers: {
            [s.agentId]: { name: s.agentName(), requires_openai_auth: false },
          },
        },
        origins: {},
        layers: [],
      }
    }
    case 'config/value/write':
    case 'config/batchWrite': {
      // 桌面端改默认模型时写这里：存在适配器库里，新建会话时交给 agent，不动 agent 自己的配置
      const edits: any[] =
        method === 'config/batchWrite' ? (p.edits ?? []) : [{ keyPath: p.keyPath, value: p.value }]
      const allowed = ['model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode']
      for (const edit of edits)
        if (!allowed.includes(edit?.keyPath))
          throw new ProtocolError(-32602, `${s.agentId} 入口不支持修改 ${edit?.keyPath}`)
      const saved = s.store.getMeta('config', 'defaults') ?? {}
      for (const edit of edits) saved[edit.keyPath] = edit.value
      s.store.setMeta('config', 'defaults', saved)
      return { status: 'ok', version: s.agentId, filePath: '', overriddenMetadata: null }
    }
    default:
      return threads(s, peer, method, p)
  }
}

// 会话、回合、技能这些
async function threads(s: AcpServer, peer: RpcPeer, method: string, p: any): Promise<any> {
  switch (method) {
    case 'thread/start': {
      const cwd = p.cwd ?? process.cwd()
      if (typeof cwd !== 'string' || !isAbsolute(cwd))
        throw new ProtocolError(-32602, 'cwd 必须是绝对路径')
      const saved = s.store.getMeta('config', 'defaults') ?? {}
      const selection = {
        model: p.model ?? p.config?.model ?? saved.model,
        effort: p.config?.model_reasoning_effort ?? saved.model_reasoning_effort,
      }
      if (p.ephemeral === true) {
        // 临时线程不建 agent 会话
        const live = s.openEphemeral(peer, cwd)
        // 没有 agent 会话可设置，只记下来回报：不认识的值不管
        s.applySettings(live, selection, true)
        const started = envelope(s, live.projection.thread)
        setImmediate(() => s.notify(started.id, 'thread/started', { thread: started }))
        return settings(s, live)
      }
      // 项目不在就不建会话：建好了才发现，会在 agent 那边留下一个没人要的空会话
      if (p.projectId) s.projects.read(p.projectId)
      const live = await s.create(cwd)
      const { thread } = live.projection
      s.subscribe(peer, thread.id)
      // 桌面可能带着别的引擎的模型名新建；允许回退时不认识的值不管，用 agent 的默认
      s.applySettings(live, selection, p.allowProviderModelFallback === true)
      await s.updateSettings(live, {}).catch((error) => {
        if (p.allowProviderModelFallback !== true) throw error
      })
      if (p.projectId) s.projects.assignThread(thread.id, p.projectId)
      const resolved = settings(s, live)
      const started = { ...resolved.thread, turns: [] }
      setImmediate(() => s.notify(thread.id, 'thread/started', { thread: started }))
      return resolved
    }
    case 'thread/list': {
      const rows = (await s.sessions())
        .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
        .filter((thread) => {
          const metadata = s.store.getMeta('thread', thread.id) ?? {}
          return (
            (metadata.archived === true) === (p.archived === true) &&
            !p.parentThreadId &&
            (!p.sourceKinds?.length || p.sourceKinds.includes('appServer')) &&
            (p.cwd == null ||
              (Array.isArray(p.cwd) ? p.cwd.includes(thread.cwd) : thread.cwd === p.cwd)) &&
            (p.projectId === undefined || s.projects.projectId(thread.id) === p.projectId) &&
            (p.sectionId === undefined || (metadata.sectionId ?? null) === p.sectionId) &&
            (typeof p.isPinned !== 'boolean' ||
              (metadata.sectionId === PINNED_SECTION_ID) === p.isPinned) &&
            (!p.searchTerm || `${thread.name ?? ''} ${thread.preview}`.includes(p.searchTerm))
          )
        })
      return pageRecords(
        rows.map((thread) => envelope(s, thread)),
        p,
        `threads:${JSON.stringify([p.archived === true, p.projectId, p.sectionId, p.isPinned, p.cwd, p.parentThreadId, p.sourceKinds, p.searchTerm])}`,
        (thread) => thread.id,
      )
    }
    case 'thread/loaded/list':
      return { data: [...s.live.keys(), ...s.ephemeral.keys()], nextCursor: null }
    case 'thread/resume':
    case 'thread/read': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      const { thread, turns } = live.projection
      // 和上游一样，thread/read 只读不订阅
      if (method === 'thread/read')
        return { thread: envelope(s, thread, p.includeTurns === false ? [] : turns) }
      s.subscribe(peer, thread.id)
      const resumed = settings(s, live)
      if (p.excludeTurns === true) resumed.thread.turns = []
      return { ...resumed, ...historyHeadCursors(thread.id, turns) }
    }
    case 'thread/fork': {
      const source = await s.load(requiredString(p.threadId, 'threadId'))
      if (source.projection.thread.ephemeral) throw new ProtocolError(-32602, '临时线程不能分叉')
      if (p.ephemeral === true) throw new ProtocolError(-32602, 'ACP 入口不支持临时分叉')
      // ACP 的 session/fork 不带位置：只能从末尾分
      const turns = source.projection.snapshot()
      if (p.beforeTurnId != null || (p.lastTurnId != null && p.lastTurnId !== turns.at(-1)?.id))
        throw new ProtocolError(-32602, 'ACP 入口只能从会话末尾分叉')
      const live = await s.fork(source)
      const { thread } = live.projection
      s.subscribe(peer, thread.id)
      const forked = settings(s, live)
      if (p.excludeTurns === true) forked.thread.turns = []
      const started = { ...forked.thread, turns: [] }
      setImmediate(() => s.notify(thread.id, 'thread/started', { thread: started }))
      return forked
    }
    case 'thread/unsubscribe': {
      const subscribed = s.subscriptions.get(p.threadId)?.delete(peer.id)
      const ephemeral = s.releaseEphemeral(p.threadId)
      return {
        status: subscribed
          ? 'unsubscribed'
          : s.live.has(p.threadId) || ephemeral
            ? 'notSubscribed'
            : 'notLoaded',
      }
    }
    case 'turn/start':
      return { turn: s.start(peer, await s.load(requiredString(p.threadId, 'threadId')), p) }
    case 'turn/interrupt':
      await s.interrupt(requiredString(p.threadId, 'threadId'))
      return {}
    case 'thread/name/set': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      const name = requiredString(p.name, 'name')
      const { projection } = live
      if (projection.thread.name === name) return {}
      // ACP 没有改名的方法：名字记在适配器这边，之后 agent 报的标题不再盖掉它
      projection.thread.name = name
      projection.userNamed = true
      s.save(live)
      s.notify(p.threadId, 'thread/name/updated', { threadName: name })
      return {}
    }
    case 'thread/goal/get':
      await s.load(requiredString(p.threadId, 'threadId'))
      return { goal: null }
    case 'thread/settings/update':
    case 'turn/settings/update': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      await s.updateSettings(live, p)
      s.notify(p.threadId, 'thread/settings/updated', { threadSettings: settings(s, live) })
      return method === 'turn/settings/update' ? { status: 'applied' } : {}
    }
    case 'thread/turns/list': {
      const { turns } = (await s.load(requiredString(p.threadId, 'threadId'))).projection
      return pageRecords(turns, p, `turns:${p.threadId}`, (turn) => turn.id)
    }
    case 'thread/turns/items/list':
    case 'thread/items/list':
      return pageThreadItems(
        p.threadId,
        (await s.load(requiredString(p.threadId, 'threadId'))).projection.turns,
        p,
      )
    case 'thread/archive':
    case 'thread/unarchive': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      const archived = method === 'thread/archive'
      if (archived) await s.interrupt(p.threadId)
      s.store.setMeta('thread', p.threadId, {
        ...(s.store.getMeta('thread', p.threadId) ?? {}),
        archived,
      })
      setImmediate(() =>
        s.notify(p.threadId, archived ? 'thread/archived' : 'thread/unarchived', {}),
      )
      return archived ? {} : { thread: envelope(s, live.projection.thread) }
    }
    case 'thread/metadata/update': {
      const { thread } = (await s.load(requiredString(p.threadId, 'threadId'))).projection
      if (p.projectId != null) {
        const projectId = p.projectId === '' ? null : requiredString(p.projectId, 'projectId')
        if (s.projects.assignThread(thread.id, projectId))
          s.notify(thread.id, 'thread/project/updated', { projectId })
      }
      return { thread: envelope(s, thread) }
    }
    case 'threadSection/list':
      return pageRecords([PINNED_SECTION], p, 'sections', (section) => section.id)
    case 'thread/queue/list':
    case 'thread/attachment/list':
      return { data: [], nextCursor: null, backwardsCursor: null }
    case 'thread/backgroundTerminals/list':
      return { data: [], nextCursor: null }
    case 'thread/backgroundTerminals/clean':
    case 'thread/increment_elicitation':
    case 'thread/decrement_elicitation':
      return {}
    case 'skills/list': {
      s.watchSkills(peer)
      const cwds: string[] = Array.isArray(p.cwds) && p.cwds.length ? p.cwds : [process.cwd()]
      return { data: cwds.map((cwd) => ({ cwd, skills: skills(s, cwd), errors: [] })) }
    }
    case 'fuzzyFileSearch':
      return s.search.search(p)
    case 'fuzzyFileSearch/sessionStart':
      return s.searches.start(peer, p)
    case 'fuzzyFileSearch/sessionUpdate':
      return s.searches.update(peer, p)
    case 'fuzzyFileSearch/sessionStop':
      return s.searches.stop(p)
    case 'gitDiffToRemote': {
      const cwd = p.cwd ?? process.cwd()
      const diff = await gitDiffToRemote(cwd)
      if (!diff)
        throw new ProtocolError(
          -32600,
          `failed to compute git diff to remote for cwd: ${JSON.stringify(cwd)}`,
        )
      return diff
    }
    default:
      throw unsupported(s, method)
  }
}
