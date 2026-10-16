// 假的“原生 codex 上游”：照真的 codex app-server（0.160.0，隔离的数据目录里对着假模型跑出来的）的样子应答。
// CI 上没有 codex，自动化测试都对着它。和适配器的假运行时（fake-upstream.mts）不一样的地方：
//   - 握手应答的 userAgent 是“<客户端名>/<codex 版本> (<系统>; <架构>) unknown (<客户端名>; <客户端版本>)”；
//   - 不认识 runtime/info，也不认识我们的任何扩展键；
//   - 不认识的方法回 -32600“Invalid request: unknown variant `<方法名>`, expected one of …”，
//     参数不对也是 -32600，原文不一样；
//   - 标着实验性的方法，握手时没声明 experimentalApi 的连接上回“<方法名> requires experimentalApi capability”；
//   - 服务端请求的请求号是递增的整数，从 0 起；命令审批带 availableDecisions，文件改动审批不带。
import {
  type FakeConnection,
  type FakeProject,
  type FakeThread,
  FakeUpstream,
  RpcFailure,
} from './fake-upstream.mjs'

/** 它内置的三个权限档，permissionProfile/list 给的就是这个形状 */
export const CODEX_PROFILES = [
  { id: ':read-only', description: null, allowed: true },
  { id: ':workspace', description: null, allowed: true },
  { id: ':danger-full-access', description: null, allowed: true },
]

const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never']

/** 握手时没声明 experimentalApi 就用不了的方法（上游源码里标着 experimental 的） */
const EXPERIMENTAL = new Set(['project/list', 'thread/queue/list'])

/** 造一个 codex 的会话对象：字段照协议里的 Thread，标识是它那种 UUID */
export function codexThread(serial: number, updatedAt: number, more: Partial<FakeThread> = {}) {
  const id = `019a0000-0000-7000-8000-${String(serial).padStart(12, '0')}`
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: `codex 会话 ${serial}`,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    modelProvider: 'openai',
    createdAt: updatedAt - 10,
    updatedAt,
    status: { type: 'notLoaded' },
    path: `/fake/codex-home/sessions/rollout-${id}.jsonl`,
    cwd: '/work/codex',
    cliVersion: '0.160.0',
    source: 'cli',
    gitInfo: null,
    name: null,
    turns: [],
    ...more,
  } satisfies FakeThread
}

export class FakeCodex extends FakeUpstream {
  /** `codex --version` 报的那个版本，也出现在握手应答的 userAgent 里 */
  cliVersion = '0.160.0'
  /** permissionProfile/list 给的权限档 */
  profiles = CODEX_PROFILES.map((profile) => ({ ...profile }))
  /** 每条连接握手时带来的参数，按连上的顺序 */
  readonly greetings: any[] = []
  private readonly experimental = new WeakSet<FakeConnection>()
  private nextRequest = 0

  constructor(threads: FakeThread[] = [], projects: FakeProject[] | null = null) {
    super(null, threads)
    this.projects = projects
    this.sections = []
    // 它没有这个方法：落到“不认识的方法”上
    delete this.handlers['runtime/info']
    this.unknownMethod = (method) => ({
      code: -32600,
      message: `Invalid request: unknown variant \`${method}\`, expected one of \`initialize\`, \`thread/start\`, \`thread/resume\`, \`thread/fork\`, \`turn/start\`, \`model/list\``,
    })
    this.handlers.initialize = (params, connection) => {
      this.greetings.push(params)
      if (params.capabilities?.experimentalApi === true) this.experimental.add(connection)
      const name = params.clientInfo?.name ?? 'unknown'
      return {
        userAgent: `${name}/${this.cliVersion} (Mac OS 26.5.0; arm64) unknown (${name}; ${params.clientInfo?.version ?? ''})`,
        codexHome: '/fake/codex-home',
        platformFamily: 'unix',
        platformOs: 'macos',
      }
    }
    this.handlers['permissionProfile/list'] = () => ({ data: this.profiles, nextCursor: null })
    this.handlers['thread/unsubscribe'] = () => ({ status: 'unsubscribed' })
    for (const method of EXPERIMENTAL) {
      const inner = this.handlers[method] ?? (() => ({}))
      this.handlers[method] = (params, connection) => {
        if (!this.experimental.has(connection))
          throw new RpcFailure(-32600, `${method} requires experimentalApi capability`)
        return inner(params, connection)
      }
    }
    // 参数不对的两种原话：缺字段，和枚举值不认识（后一种也是 unknown variant，但点名的是那个值）
    const inspect = (params: any) => {
      if (typeof params.threadId !== 'string')
        throw new RpcFailure(-32600, 'Invalid request: missing field `threadId`')
      const policy = params.approvalPolicy
      if (policy != null && !APPROVAL_POLICIES.includes(policy))
        throw new RpcFailure(
          -32600,
          `Invalid request: unknown variant \`${policy}\`, expected one of \`untrusted\`, \`on-request\`, \`granular\`, \`never\``,
        )
    }
    this.handlers['turn/start'] = (params) => {
      inspect(params)
      if (!this.threads.some((thread) => thread.id === params.threadId))
        throw new RpcFailure(-32600, `thread not found: ${params.threadId}`)
      return { turn: { id: `turn-of-${params.threadId}`, status: 'inProgress', items: [] } }
    }
    this.handlers['thread/settings/update'] = (params, connection) => {
      if (!this.experimental.has(connection))
        throw new RpcFailure(-32600, 'thread/settings/update requires experimentalApi capability')
      inspect(params)
      return {}
    }
    // 会话标识不是它那种写法的，它不去找，直接说标识无效
    const read = this.handlers['thread/read'] as NonNullable<(typeof this.handlers)[string]>
    this.handlers['thread/read'] = (params, connection) => {
      if (!/^[0-9a-f-]{36}$/.test(String(params.threadId)))
        throw new RpcFailure(-32600, `invalid thread id: ${params.threadId}`)
      return read(params, connection)
    }
  }

  /** 以 codex 的方式发一个要客户端答复的请求：请求号是递增的整数。返回这个请求号 */
  ask(method: string, params: Record<string, unknown>): number {
    const id = this.nextRequest++
    for (const connection of this.live) connection.send({ id, method, params })
    return id
  }

  /**
   * 动态工具调用（item/tool/call）。真的 codex 只发给订阅着会话的连接，to 给出是哪几条；
   * 同一个请求发给每条的请求号相同（实测）。返回请求号和参数，补发时用得上
   */
  toolCall(
    threadId: string,
    namespace: string,
    to: FakeConnection[] = this.live,
    callId = 'call_tool_1',
  ): { id: number; params: Record<string, unknown> } {
    const id = this.nextRequest++
    const params = {
      threadId,
      turnId: `turn-of-${threadId}`,
      callId,
      namespace,
      tool: 'echo',
      arguments: { text: 'hi' },
    }
    for (const connection of to) connection.send({ id, method: 'item/tool/call', params })
    return { id, params }
  }

  /** 命令审批：它自己带着决定列表，里面有带参数的决定 */
  commandApproval(threadId: string): number {
    return this.ask('item/commandExecution/requestApproval', {
      threadId,
      turnId: `turn-of-${threadId}`,
      itemId: 'call_1',
      startedAtMs: 1,
      environmentId: null,
      command: "/bin/zsh -lc 'echo hi > out.txt'",
      cwd: '/work/codex',
      commandActions: [{ type: 'unknown', command: 'echo hi > out.txt' }],
      proposedExecpolicyAmendment: ['echo', 'hi'],
      availableDecisions: [
        'accept',
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo', 'hi'] } },
        'cancel',
      ],
    })
  }

  /** 文件改动审批：标准协议里不带决定列表 */
  fileChangeApproval(threadId: string): number {
    return this.ask('item/fileChange/requestApproval', {
      threadId,
      turnId: `turn-of-${threadId}`,
      itemId: 'call_2',
      startedAtMs: 2,
      reason: null,
      grantRoot: null,
    })
  }

  /** 客户端答了之后它会说一声这个请求有结果了 */
  resolved(threadId: string, requestId: number): void {
    this.notify('serverRequest/resolved', { threadId, requestId })
  }
}
