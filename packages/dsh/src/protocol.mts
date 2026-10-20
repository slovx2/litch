import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { EXTENSION, EXTENSIONS_CAPABILITY } from '../../protocol/src/device.mjs'
import { clientToolNamespaces } from '../../shared/src/client-tool-executor.mjs'
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
import { dshClientTools } from './client-tools.mjs'
import { envelope, PROFILE, settings, summary } from './envelope.mjs'
import { describeSettings, fromRemote, mutateSettings, type PathOp } from './harness-common.mjs'
import type { Preset } from './projection.mjs'
import { type DshServer, presetFromParams } from './server.mjs'
import { promptContent } from './turn.mjs'
import { runtimeInfo, versions } from './versions.mjs'

const unsupported = (method: string) =>
  new ProtocolError(-32601, `dsh 入口（打样阶段）不支持 ${method}`)

// dsh 没有对应物的能力：与 Claude 入口同一做法，明确答复"不适用"（-32004），不报"方法不存在"，也不伪造成功。
const NOT_APPLICABLE: Record<string, string> = {
  // dsh 的 MCP 服务由 dsh 自己配置和管理，远程接口没有公开状态；这里无法如实列出，不能回一个空列表充数。
  'mcpServerStatus/list': 'dsh 的 MCP 服务由 dsh 自己管理，远程接口没有公开其状态',
  'app/installed': 'OpenAI 应用连接器是 Codex 专属能力',
  'plugin/installed': 'Codex 插件是 Codex 专属能力',
  'marketplace/add': 'Codex 插件市场是 Codex 专属能力',
}

async function models(s: DshServer): Promise<any[]> {
  const catalog = await s.catalog()
  return (catalog.groups ?? []).flatMap((group: any) =>
    (group.models ?? []).map((model: any) => ({
      id: `${group.id}/${model.id}`,
      model: `${group.id}/${model.id}`,
      displayName: model.name ?? model.id,
      description: model.description ?? group.name ?? group.id,
      hidden: false,
      modelSpecialty: null,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      isDefault: catalog.default?.provider === group.id && catalog.default?.model === model.id,
      supportedReasoningEfforts: (model.reasoning?.efforts ?? []).map((effort: any) => ({
        reasoningEffort: effort.id,
        description: effort.description ?? effort.name ?? effort.id,
      })),
      defaultReasoningEffort: model.reasoning?.defaultEffort ?? 'off',
      inputModalities: ['text', 'image'],
      supportsPersonality: false,
      upgrade: null,
      availabilityNux: null,
      upgradeInfo: null,
    })),
  )
}

/**
 * dsh 给新会话的权限预设（permissionPresets/catalog 的 defaultPreset，dsh 建会话时就用它），换成权限档的标识。
 * 不是三个内置预设之一（用户自己配的）或问不到时是 null
 */
async function defaultPermissions(s: DshServer): Promise<string | null> {
  const catalog = await s
    .remote()
    .then((remote) =>
      remote.rpc(
        'permissionPresets/catalog',
        {},
        (value) => typeof value?.defaultPreset === 'string',
      ),
    )
    .catch(() => null)
  const preset = catalog?.defaultPreset
  return Object.hasOwn(PROFILE, preset) ? PROFILE[preset as Preset] : null
}

// 官方桌面端写默认设置的几个键（config/value/write、config/batchWrite）落到 dsh 自己的设置上：
// 模型和强度是 agent-default-model，沙箱是默认权限预设（permission.defaultPreset，三个内置预设的名字和 sandbox_mode
// 的取值一样）。审批策略在 dsh 里跟着预设走（只有完全访问那一档不问），单独写不了。
const DEFAULT_KEYS = ['model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode']
const approvalOf = (preset: string | null) =>
  preset === 'danger-full-access' ? 'never' : 'on-request'

async function writeDefaults(s: DshServer, edits: any[]): Promise<void> {
  for (const edit of edits)
    if (!DEFAULT_KEYS.includes(edit.keyPath))
      throw new ProtocolError(-32602, `dsh 入口不支持修改 ${edit.keyPath}`)
  const remote = await s.remote()
  const { namespaces } = await describeSettings(remote)
  const defaults = namespaces.get('agent-default-model')
  const preset = namespaces.get('permission')
  const model: PathOp[] = []
  const permission: PathOp[] = []
  for (const { keyPath, value } of edits) {
    if (keyPath === 'model') {
      const slash = typeof value === 'string' ? value.indexOf('/') : -1
      if (slash < 1) throw new ProtocolError(-32602, '模型格式必须为 provider/model')
      model.push(
        { op: 'set', path: ['provider'], value: value.slice(0, slash) },
        { op: 'set', path: ['model'], value: value.slice(slash + 1) },
      )
    } else if (keyPath === 'model_reasoning_effort')
      model.push(
        value == null
          ? { op: 'unset', path: ['reasoningEffort'] }
          : { op: 'set', path: ['reasoningEffort'], value },
      )
    else if (keyPath === 'sandbox_mode') {
      if (!Object.hasOwn(PROFILE, value))
        throw new ProtocolError(-32602, `dsh 没有 ${value} 这个权限预设`)
      permission.push({ op: 'set', path: ['defaultPreset'], value })
    } else if (value !== approvalOf(preset?.value?.defaultPreset ?? null))
      throw new ProtocolError(
        -32602,
        'dsh 的审批跟着权限预设走，单独改不了；改 sandbox_mode 换预设',
      )
  }
  // provider、model 是必填的：用户层还没写过、这次只改强度时，把现在生效的那一对一起写上
  if (
    model.length &&
    defaults?.user?.provider === undefined &&
    !model.some((op) => op.path[0] === 'provider')
  )
    model.unshift(
      { op: 'set', path: ['provider'], value: defaults?.value?.provider },
      { op: 'set', path: ['model'], value: defaults?.value?.model },
    )
  try {
    if (model.length) await mutateSettings(remote, 'agent-default-model', model, defaults?.revision)
    if (permission.length) await mutateSettings(remote, 'permission', permission, preset?.revision)
  } catch (error) {
    throw new ProtocolError(-32603, fromRemote(error).message)
  }
}

export async function dispatch(s: DshServer, peer: RpcPeer, method: string, p: any): Promise<any> {
  // harness 详情设置（harnessConfig 扩展）：litch/device/instructions/* 是设备进程自己的，不会到这里
  if (method.startsWith('litch/harness/')) return s.harnessConfig.handle(method, p)
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
  if (method.startsWith('project/')) {
    // 项目的最近活动时间、导入的会话在不在，都要看 dsh 现有哪些会话：先问一遍。
    await s.sessions()
    return projectRequest(
      s.projects,
      method,
      p,
      (projectId, changeType) => s.notify(null, 'project/changed', { projectId, changeType }),
      (threadId, projectId) => s.notify(threadId, 'thread/project/updated', { projectId }),
    )
  }
  if (NOT_APPLICABLE[method])
    throw new ProtocolError(
      -32004,
      `dsh 运行时不适用此能力: ${method}（${NOT_APPLICABLE[method]}）`,
    )
  switch (method) {
    case 'initialize':
      // 客户端退订的通知，这条连接上从现在起不发。
      applyNotificationOptOut(peer, p)
      // 这条连接能执行哪些客户端工具命名空间（clientTools 扩展），挑执行方时看
      s.toolNamespaces.set(peer.id, clientToolNamespaces(p))
      // 声明了 harnessConfig 的才收配置变化、登录进展的通知
      if (
        Array.isArray(p.capabilities?.[EXTENSIONS_CAPABILITY]) &&
        p.capabilities[EXTENSIONS_CAPABILITY].includes(EXTENSION.harnessConfig)
      )
        s.configPeers.add(peer.id)
      return {
        userAgent: codexUserAgent(
          typeof p.clientInfo?.name === 'string' ? p.clientInfo.name : 'codex-app',
          typeof p.clientInfo?.version === 'string' ? p.clientInfo.version : 'unknown',
          versions.protocol,
          'codex-harness-adapter-dsh',
        ),
        codexHome: process.env.CODEX_HOME ?? process.cwd(),
        platformFamily: platformFamily(),
        platformOs: platformOs(),
      }
    case 'runtime/info':
      return runtimeInfo()
    case 'server/diagnostics':
      // 形状照上游：进程信息加一组计数。只报本适配器进程实测的数，物理占用没有等价的量法。
      return {
        process: {
          id: process.pid,
          residentMemoryBytes: process.memoryUsage.rss(),
          physicalFootprintBytes: null,
        },
        gauges: [{ name: 'dsh_adapter.loaded_sessions', value: s.live.size }],
      }
    case 'currentTime/read':
      return { currentTime: new Date().toISOString() }
    case 'account/read':
      return { account: null, requiresOpenaiAuth: false }
    case 'getAuthStatus':
      return { authMethod: null, authToken: null, requiresOpenaiAuth: false }
    case 'account/rateLimits/read':
      // dsh 不报限额。上游这里的 rateLimits 必须是一份快照，没有数据时各项为空，不能整个给 null。
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
      // 命名空间形式的动态工具经插件交给 dsh 的模型（client-tools.mts）
      return { imageGeneration: false, webSearch: false }
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
      // 没有已实现的实验开关：空映射是无操作，其余完整校验后拒绝，不能回显成已应用。
      if (Object.keys(enablement).length)
        throw new ProtocolError(-32004, 'dsh 运行时尚未实现所请求的实验功能开关；未修改任何设置')
      return { enablement: {} }
    }
    case 'plugin/list':
      return { marketplaces: [], marketplaceLoadErrors: [], featuredPluginIds: [] }
    case 'plugin/share/list':
      return { data: [] }
    case 'externalAgentConfig/detect':
      return { items: [] }
    case 'permissionProfile/list':
      return {
        data: [':read-only', ':workspace', ':danger-full-access'].map((id) => ({
          id,
          description: null,
          allowed: true,
        })),
        nextCursor: null,
      }
    case 'collaborationMode/list':
      return {
        data: [
          {
            name: 'default',
            mode: 'default',
            model: null,
            reasoning_effort: null,
            developer_instructions: null,
          },
        ],
      }
    case 'model/list':
      return { data: await models(s), nextCursor: null }
    case 'config/read': {
      // 不带设置新建的会话会用的（客户端的新建页照它显示）：模型和强度是 dsh 自己的默认
      //（agent-default-model，就是模型目录里的 default，DshServer.selection），权限档是 dsh 给新会话的默认预设
      const { model, effort } = await s.selection({ ephemeral: false, model: null, effort: null })
      const permissions = await defaultPermissions(s)
      const preset = (Object.entries(PROFILE).find(([, id]) => id === permissions)?.[0] ??
        null) as Preset | null
      return {
        config: {
          model,
          model_provider: 'dsh',
          model_reasoning_effort: effort,
          approval_policy: approvalOf(preset),
          sandbox_mode: preset ?? 'workspace-write',
          default_permissions: permissions,
          features: {},
          model_providers: { dsh: { name: 'DSH', requires_openai_auth: false } },
        },
        origins: {},
        layers: [],
      }
    }
    case 'config/value/write':
    case 'config/batchWrite': {
      // 桌面端改默认模型与权限时写这里：写进 dsh 自己的设置（和用户在 dsh 里改的是同一份）
      await writeDefaults(
        s,
        method === 'config/batchWrite' ? (p.edits ?? []) : [{ keyPath: p.keyPath, value: p.value }],
      )
      return { status: 'ok', version: 'dsh', filePath: '', overriddenMetadata: null }
    }
    case 'thread/start': {
      const cwd = p.cwd ?? process.cwd()
      if (typeof cwd !== 'string' || !isAbsolute(cwd))
        throw new ProtocolError(-32602, 'cwd 必须是绝对路径')
      if (p.ephemeral === true) {
        // 临时线程不建 dsh 会话；模型只用于回报，按目录核对，允许回退时改用默认模型。
        const catalog = await models(s)
        const requested = p.model ?? p.config?.model ?? null
        const known = catalog.find((model) => model.id === requested)
        if (requested && !known && !p.allowProviderModelFallback)
          throw new ProtocolError(-32602, `dsh 没有模型 ${requested}`)
        const chosen = known ?? catalog.find((model) => model.isDefault) ?? null
        const live = s.openEphemeral(peer, {
          cwd,
          model: chosen?.id ?? null,
          effort:
            p.effort ?? p.config?.model_reasoning_effort ?? chosen?.defaultReasoningEffort ?? null,
          preset: presetFromParams(p),
        })
        const started = envelope(s, live.projection.thread)
        setImmediate(() => s.notify(started.id, 'thread/started', { thread: started }))
        return settings(s, live)
      }
      // 项目不在、动态工具的形状不对就不建会话：dsh 没有删除会话的接口，建好了才发现会留下一个没人要的空会话。
      if (p.projectId) s.projects.read(p.projectId)
      const clientTools = dshClientTools(p.dynamicTools)
      const remote = await s.remote()
      const created = await remote.rpc(
        'session/create',
        { request: { cwd } },
        (value) => typeof value?.sessionId === 'string',
      )
      const live = await s.load(created.sessionId)
      const { thread } = live.projection
      s.subscribe(peer, thread.id)
      // 动态工具记到会话上，交给 dsh 里的插件装好再回应答：客户端拿到应答就可能发第一句话
      if (clientTools.length) await s.setClientTools(thread.id, p.dynamicTools)
      live.preset = presetFromParams(p)
      // 没带的用 dsh 自己的默认（新会话本来就用它），不用另设
      const selection = {
        model: p.model ?? p.config?.model,
        effort: p.effort ?? p.config?.model_reasoning_effort,
      }
      // 桌面可能带着别的引擎的模型名新建线程；允许回退时改用 dsh 默认模型。
      await s.applySettings(remote, live, selection).catch((error) => {
        if (!p.allowProviderModelFallback) throw error
      })
      if (p.projectId) s.projects.assignThread(thread.id, p.projectId)
      const resolved = await settings(s, live)
      // 通知里的会话对象和应答里的是同一份（不带回合）
      const started = { ...resolved.thread, turns: [] }
      setImmediate(() => s.notify(thread.id, 'thread/started', { thread: started }))
      return resolved
    }
    case 'thread/list': {
      const rows = (await s.listedSessions())
        .map((item) => s.live.get(item.sessionId)?.projection.thread ?? summary(item))
        .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
        .filter((thread) => {
          const metadata = s.store.getMeta('thread', thread.id) ?? {}
          const subagent = Boolean(thread.parentThreadId)
          return (
            (metadata.archived === true) === (p.archived === true) &&
            (p.parentThreadId ? thread.parentThreadId === p.parentThreadId : true) &&
            (p.sourceKinds?.length
              ? p.sourceKinds.includes(subagent ? 'subAgentThreadSpawn' : 'appServer')
              : p.parentThreadId || !subagent) &&
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
      // 和上游一样，thread/read 只读不订阅：官方桌面端找置顶会话在哪台机器上时，拿会话号向每个入口都读一遍
      if (method === 'thread/resume') s.subscribe(peer, thread.id)
      if (method === 'thread/read') {
        // 会话对象上跟着模型走的只有提供方这一项：和带设置的应答报的是同一个
        const modelProvider = (await s.selection(thread)).model?.split('/')[0] ?? 'dsh'
        const read = envelope(s, thread, p.includeTurns === false ? [] : turns)
        return { thread: { ...read, modelProvider } }
      }
      const resumed = await settings(s, live)
      // excludeTurns 时不带回合，历史由客户端按游标另取。
      if (p.excludeTurns === true) resumed.thread.turns = []
      return { ...resumed, ...historyHeadCursors(thread.id, turns) }
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
      await s.interrupt(p.threadId)
      return {}
    case 'turn/steer': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      const active = live.projection.active
      if (!active || active.id !== p.expectedTurnId)
        throw new ProtocolError(-32009, '指定回合与活动回合不一致')
      s.assertDirectInput(live)
      const content = await promptContent(p.input ?? [])
      // 回合是适配器先建的，提示词随后才交给 dsh（见 DshServer.start）。插话先到的话 dsh 那边还没有回合可并：
      // 它拿插话起了回合，原来那句排到后面成了另一个回合，两句的先后就反了。所以和打断一样，等提示词交到了再发。
      // 没交成的回合已经按失败收尾，不再是活动回合。
      await live.delivered
      if (live.projection.active !== active)
        throw new ProtocolError(-32009, '指定回合与活动回合不一致')
      const requestId = p.clientUserMessageId ?? p.clientMessageId ?? randomUUID()
      s.remember(p.threadId, requestId, p.input ?? [])
      // dsh 的插话在当前这一步结束后并入同一回合，不会立即打断模型。
      await s.prompt(await s.remote(), live, requestId, 'steer', content)
      return { turnId: active.id }
    }
    case 'thread/name/set': {
      const { projection } = await s.load(requiredString(p.threadId, 'threadId'))
      const name = requiredString(p.name, 'name')
      // 与当前标题相同：无事可做，也不把它钉成用户标题。
      if (projection.thread.name === name) return {}
      // dsh 还没给这个会话起过标题时，客户端写来的名字只当临时名（桌面端在首条消息发出前会把消息原文
      // 写回）：不调用 dsh 的改名。dsh 把改名视为用户标题并钉住，之后不再自动生成，模型起的标题就出不来了。
      if (projection.thread.ephemeral || !projection.titled) {
        projection.thread.name = name
        projection.wanted = name
        s.notify(p.threadId, 'thread/name/updated', { threadName: name })
        return {}
      }
      await (await s.remote()).rpc('session/rename', {
        request: { sessionId: p.threadId, title: name },
      })
      return {}
    }
    case 'thread/goal/get':
      // dsh 没有目标功能：线程存在时如实回报"没有目标"。
      await s.load(requiredString(p.threadId, 'threadId'))
      return { goal: null }
    case 'thread/settings/update':
    case 'turn/settings/update': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      await s.applySettings(await s.remote(), live, p)
      s.notify(p.threadId, 'thread/settings/updated', { threadSettings: await settings(s, live) })
      return method === 'turn/settings/update' ? { status: 'applied' } : {}
    }
    case 'thread/turns/list': {
      const { turns } = (await s.load(p.threadId)).projection
      return pageRecords(turns, p, `turns:${p.threadId}`, (turn) => turn.id)
    }
    case 'thread/turns/items/list':
    case 'thread/items/list':
      return pageThreadItems(p.threadId, (await s.load(p.threadId)).projection.turns, p)
    case 'thread/archive':
    case 'thread/unarchive': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      const archived = method === 'thread/archive'
      if (archived) await s.interrupt(p.threadId)
      s.store.setMeta('thread', p.threadId, {
        ...(s.store.getMeta('thread', p.threadId) ?? {}),
        archived,
      })
      // 照上游：先回应答，再广播（rust-v0.162.0-alpha.20 的 thread_archive、thread_unarchive）
      setImmediate(() =>
        s.notify(p.threadId, archived ? 'thread/archived' : 'thread/unarchived', {}),
      )
      return archived ? {} : { thread: envelope(s, live.projection.thread) }
    }
    case 'thread/metadata/update': {
      const { thread } = (await s.load(requiredString(p.threadId, 'threadId'))).projection
      // 只认归属这一项，读法和 Claude Code 的入口一样：给了项目就放进去，空串是拿出来，没给不动。
      // 别的字段（分支信息等）dsh 的入口不记。
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
    case 'skills/list':
      return s.skills.list(peer, p)
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
      // 算不出来（不是仓库、没有远端可比）时原生报“无效请求”，不回一个空结果
      if (!diff)
        throw new ProtocolError(
          -32600,
          `failed to compute git diff to remote for cwd: ${JSON.stringify(cwd)}`,
        )
      return diff
    }
    default:
      throw unsupported(method)
  }
}
