import { isAbsolute } from 'node:path'
import { backgroundTerminalsPage, withBackground } from '../../shared/src/background-report.mjs'
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
import { DEFAULT_EFFORT } from './catalog.mjs'
import { dynamicToolSpecs, toolRules, toolRuleset } from './client-tools.mjs'
import { envelope, settings } from './envelope.mjs'
import { threadMutation } from './mutations.mjs'
import type { OpencodeServer, ThreadSettings } from './server.mjs'
import { isDefaultTitle, presetFromParams } from './sessions.mjs'
import { listSkills } from './skills.mjs'
import { runtimeInfo, versions } from './versions.mjs'

const unsupported = (method: string) => new ProtocolError(-32601, `OpenCode 入口不支持 ${method}`)

// OpenCode 没有对应物的能力：与 Claude、dsh 入口同一做法，明确答复“不适用”（-32004），不报“方法不存在”，也不伪造成功。
const NOT_APPLICABLE: Record<string, string> = {
  // OpenCode 有 GET /mcp，但只有连没连上，没有协议要的工具和资源清单，如实列不出来，不回一个空列表充数。
  'mcpServerStatus/list': 'OpenCode 的 MCP 服务由 OpenCode 自己管理，接口里没有协议要的工具清单',
  'app/installed': 'OpenAI 应用连接器是 Codex 专属能力',
  'plugin/installed': 'Codex 插件是 Codex 专属能力',
  'marketplace/add': 'Codex 插件市场是 Codex 专属能力',
}

export async function dispatch(
  s: OpencodeServer,
  peer: RpcPeer,
  method: string,
  p: any,
): Promise<any> {
  if (method.startsWith('fs/')) return s.files.call(peer, method, p)
  if (method.startsWith('litch/harness/')) return s.harness.dispatch(peer, method, p)
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
    // 项目的最近活动时间、导入的会话在不在，都要看 OpenCode 现有哪些会话：先问一遍。
    await s.sessions.list()
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
      `OpenCode 运行时不适用此能力: ${method}（${NOT_APPLICABLE[method]}）`,
    )
  if (
    [
      'thread/fork',
      'thread/revert',
      'thread/rollback',
      'thread/delete',
      'thread/compact/start',
      'thread/shellCommand',
    ].includes(method)
  )
    return threadMutation(s, peer, method, p)
  switch (method) {
    case 'initialize':
      applyNotificationOptOut(peer, p)
      return {
        userAgent: codexUserAgent(
          typeof p.clientInfo?.name === 'string' ? p.clientInfo.name : 'codex-app',
          typeof p.clientInfo?.version === 'string' ? p.clientInfo.version : 'unknown',
          versions.protocol,
          'codex-harness-adapter-opencode',
        ),
        codexHome: process.env.CODEX_HOME ?? process.cwd(),
        platformFamily: platformFamily(),
        platformOs: platformOs(),
      }
    case 'runtime/info':
      return runtimeInfo(s.shells !== null)
    case 'server/diagnostics':
      return {
        process: {
          id: process.pid,
          residentMemoryBytes: process.memoryUsage.rss(),
          physicalFootprintBytes: null,
        },
        gauges: [{ name: 'opencode_adapter.loaded_sessions', value: s.live.size }],
      }
    case 'currentTime/read':
      return { currentTime: new Date().toISOString() }
    case 'account/read':
      return { account: null, requiresOpenaiAuth: false }
    case 'getAuthStatus':
      return { authMethod: null, authToken: null, requiresOpenaiAuth: false }
    case 'account/rateLimits/read':
      // OpenCode 不报限额；上游这里的 rateLimits 必须是一份快照，没有数据时各项为空。
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
      if (Object.keys(enablement).length)
        throw new ProtocolError(
          -32004,
          'OpenCode 运行时尚未实现所请求的实验功能开关；未修改任何设置',
        )
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
      // 计划模式就是 OpenCode 自带的 plan 代理（不许改文件），说的话进计划条目
      return {
        data: ['default', 'plan'].map((mode) => ({
          name: mode,
          mode,
          model: null,
          reasoning_effort: null,
          developer_instructions: null,
        })),
      }
    case 'model/list':
      return { data: await s.catalog.models(), nextCursor: null }
    case 'config/read': {
      const saved = s.store.getMeta('config', 'defaults') ?? {}
      return {
        config: {
          model: await s.catalog.defaultModel(),
          model_provider: 'opencode',
          model_reasoning_effort: saved.model_reasoning_effort ?? DEFAULT_EFFORT,
          approval_policy: saved.approval_policy ?? 'on-request',
          sandbox_mode: saved.sandbox_mode ?? 'workspace-write',
          default_permissions: presetFromParams({ sandbox: saved.sandbox_mode }) ?? ':workspace',
          features: {},
          model_providers: { opencode: { name: 'OpenCode', requires_openai_auth: false } },
        },
        origins: {},
        layers: [],
      }
    }
    case 'config/value/write':
    case 'config/batchWrite': {
      // 桌面端改默认模型与权限时写这里。默认模型写进 OpenCode 自己的全局配置（model），和命令行共用；
      // 强度、权限档 OpenCode 的配置里没有对应的，仍存在适配器元数据里。
      const edits: any[] =
        method === 'config/batchWrite' ? (p.edits ?? []) : [{ keyPath: p.keyPath, value: p.value }]
      const allowed = ['model', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode']
      for (const edit of edits)
        if (!allowed.includes(edit.keyPath))
          throw new ProtocolError(-32602, `OpenCode 入口不支持修改 ${edit.keyPath}`)
      const saved = s.store.getMeta('config', 'defaults') ?? {}
      for (const edit of edits)
        if (edit.keyPath === 'model')
          await s.harness.writeModel(
            typeof edit.value === 'string' && edit.value ? edit.value : null,
          )
        else saved[edit.keyPath] = edit.value
      s.store.setMeta('config', 'defaults', saved)
      return { status: 'ok', version: 'opencode', filePath: '', overriddenMetadata: null }
    }
    case 'thread/start':
      return startThread(s, peer, p)
    case 'thread/list':
      return withBackground(s.report, peer.id, await listThreads(s, p))
    case 'thread/loaded/list':
      return { data: [...s.live.keys(), ...s.ephemeral.keys()], nextCursor: null }
    case 'thread/resume':
    case 'thread/read': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      const { thread, turns } = live.projection
      // 和上游一样，thread/read 只读不订阅
      if (method === 'thread/read') {
        const read = envelope(s, thread, p.includeTurns === false ? [] : turns)
        return withBackground(s.report, peer.id, { thread: read })
      }
      s.subscribe(peer, thread.id)
      const resumed = await settings(s, live)
      if (p.excludeTurns === true) resumed.thread.turns = []
      return withBackground(s.report, peer.id, {
        ...resumed,
        ...historyHeadCursors(thread.id, turns),
      })
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
    default:
      return dispatchTurn(s, peer, method, p)
  }
}

async function startThread(s: OpencodeServer, peer: RpcPeer, p: any): Promise<any> {
  const cwd = p.cwd ?? process.cwd()
  if (typeof cwd !== 'string' || !isAbsolute(cwd))
    throw new ProtocolError(-32602, 'cwd 必须是绝对路径')
  const defaults = s.store.getMeta('config', 'defaults') ?? {}
  const base: ThreadSettings = {
    // 没指定模型的会话跟着默认走（OpenCode 配置里的 model，见 Turns.selection）
    model: p.model ?? p.config?.model ?? null,
    effort: p.effort ?? p.config?.model_reasoning_effort ?? defaults.model_reasoning_effort ?? null,
    preset:
      presetFromParams(p) ?? presetFromParams({ sandbox: defaults.sandbox_mode }) ?? ':workspace',
    plan: p.collaborationMode?.mode === 'plan',
  }
  // 桌面可能带着别的引擎的模型名新建线程：允许回退时改用 OpenCode 的默认模型。先核对再建会话，不留空会话。
  if (base.model && !(await s.catalog.has(base.model))) {
    if (!p.allowProviderModelFallback)
      throw new ProtocolError(-32602, `OpenCode 没有模型 ${base.model}`)
    base.model = null
    base.effort = null
  }
  if (p.ephemeral === true) {
    const live = s.openEphemeral(peer, cwd, base)
    const started = envelope(s, live.projection.thread)
    setImmediate(() => s.notify(started.id, 'thread/started', { thread: started }))
    return settings(s, live)
  }
  // 项目不在就不建会话；动态工具先校验，不合规矩的不建会话
  if (p.projectId) s.projects.read(p.projectId)
  const tools = dynamicToolSpecs(p.dynamicTools)
  const api = await s.api()
  // 会话的权限规则建的时候就带上动态工具那几条（第一句话经 /command 发时也只看得到自己的工具）；
  // 会话号这时还没有，先禁掉全部，有动态工具的第一次发消息时再放开自己的
  const created = await api.request('POST', '/session', {
    directory: cwd,
    body: { permission: toolRuleset(toolRules(null)) },
  })
  if (typeof created?.id !== 'string')
    throw new ProtocolError(-32603, 'OpenCode 建会话没有返回会话号')
  if (tools.length) s.clientTools.remember(created.id, p.dynamicTools)
  // 有动态工具、或者入口自己带着工具（后台 shell）的会话：有了会话号再放开自己的服务
  //（OpenCode 把这几条接在原有规则后面；之后每次发消息整个替换）
  if (s.clientTools.specs(created.id).length) {
    await api
      .request('PATCH', `/session/${created.id}`, {
        directory: cwd,
        body: { permission: toolRuleset(s.clientTools.rules(created.id, base.preset)) },
      })
      .catch((error) =>
        console.error(`[opencode] 会话 ${created.id} 的工具规则没有写上: ${error.message}`),
      )
  }
  s.sessions.saveSettings(created.id, base)
  const live = await s.load(created.id)
  const { thread } = live.projection
  s.subscribe(peer, thread.id)
  if (p.projectId) s.projects.assignThread(thread.id, p.projectId)
  const resolved = await settings(s, live)
  // 通知里的会话对象和应答里的是同一份（不带回合）
  const started = { ...resolved.thread, turns: [] }
  setImmediate(() => s.notify(thread.id, 'thread/started', { thread: started }))
  return resolved
}

async function listThreads(s: OpencodeServer, p: any): Promise<any> {
  const rows = (await s.sessions.list())
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
    .filter((thread) => {
      const metadata = s.store.getMeta('thread', thread.id) ?? {}
      const subagent = Boolean(thread.parentThreadId)
      return (
        s.sessions.archived(thread.id) === (p.archived === true) &&
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

async function dispatchTurn(s: OpencodeServer, peer: RpcPeer, method: string, p: any) {
  switch (method) {
    case 'turn/start':
      return {
        turn: await s.turns.start(peer, await s.load(requiredString(p.threadId, 'threadId')), p),
      }
    case 'turn/interrupt':
      await s.turns.interrupt(requiredString(p.threadId, 'threadId'))
      return {}
    case 'turn/steer':
      return s.turns.steer(await s.load(requiredString(p.threadId, 'threadId')), p)
    case 'thread/name/set': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      const { thread } = live.projection
      const name = requiredString(p.name, 'name')
      if (thread.name === name) return {}
      // OpenCode 还没给这个会话起标题时（标题还是默认的），客户端写来的名字只当临时名（桌面端在首条消息发出前
      // 会把消息原文写回）：不改 OpenCode 的标题，改了它就不再自动起标题了。
      if (thread.ephemeral || isDefaultTitle(thread.title)) {
        s.sessions.setLocalName(thread, name)
        return {}
      }
      await (await s.api()).request('PATCH', `/session/${thread.id}`, {
        directory: live.directory,
        body: { title: name },
      })
      thread.title = name
      thread.name = name
      s.notify(thread.id, 'thread/name/updated', { threadName: name })
      return {}
    }
    case 'thread/goal/get':
      // OpenCode 没有目标功能：线程存在时如实回报“没有目标”。
      await s.load(requiredString(p.threadId, 'threadId'))
      return { goal: null }
    case 'thread/settings/update':
    case 'turn/settings/update': {
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      await s.turns.apply(live, p)
      s.notify(p.threadId, 'thread/settings/updated', { threadSettings: await settings(s, live) })
      return method === 'turn/settings/update' ? { status: 'applied' } : {}
    }
    case 'thread/turns/list': {
      const { turns } = (await s.load(requiredString(p.threadId, 'threadId'))).projection
      return withBackground(
        s.report,
        peer.id,
        pageRecords(turns, p, `turns:${p.threadId}`, (turn) => turn.id),
        p.threadId,
      )
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
      // 归档是适配器这边的标记：OpenCode 能归档、不能取消归档（它的接口只能设归档时间）。
      const live = await s.load(requiredString(p.threadId, 'threadId'))
      const archived = method === 'thread/archive'
      if (archived) await s.turns.interrupt(p.threadId)
      s.store.setMeta('thread', p.threadId, {
        ...(s.store.getMeta('thread', p.threadId) ?? {}),
        archived,
      })
      // 照上游：先回应答，再广播
      setImmediate(() =>
        s.notify(p.threadId, archived ? 'thread/archived' : 'thread/unarchived', {}),
      )
      return archived ? {} : { thread: envelope(s, live.projection.thread) }
    }
    case 'thread/metadata/update': {
      const { thread } = (await s.load(requiredString(p.threadId, 'threadId'))).projection
      // 只认归属这一项：给了项目就放进去，空串是拿出来，没给不动。
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
    // 后台终端就是注入的后台 shell（没打开时一直是空的）；用户在这里停的不唤醒模型
    case 'thread/backgroundTerminals/list':
      return backgroundTerminalsPage(
        s.shells?.terminals(requiredString(p.threadId, 'threadId')) ?? [],
        p,
      )
    case 'thread/backgroundTerminals/terminate':
      return {
        terminated:
          s.shells?.stop(
            requiredString(p.threadId, 'threadId'),
            requiredString(p.processId, 'processId'),
            'user',
          ) === true,
      }
    case 'thread/backgroundTerminals/clean':
      s.shells?.stopThread(requiredString(p.threadId, 'threadId'), 'user')
      return {}
    case 'thread/increment_elicitation':
    case 'thread/decrement_elicitation':
      return {}
    case 'skills/list':
      return listSkills(s, p)
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
      throw unsupported(method)
  }
}
