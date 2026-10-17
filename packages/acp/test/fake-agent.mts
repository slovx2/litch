// 测试用的假 ACP agent：标准输入输出上一行一条 JSON-RPC，照 ACP 第 1 版答。回合怎么演看用户说的那句话
//（见 PROMPT 那几句），会话记在 FAKE_ACP_STATE 指的文件里，换了进程也能列出来、回放出来。
// 收到的每条消息记一行到 FAKE_ACP_LOG（用例拿来对：交没交设置、发没发取消）。
//   FAKE_ACP_VERSION      initialize 回报的协议版本（默认 1）
//   FAKE_ACP_CAPS         agentCapabilities 整个换成这一份 JSON
//   FAKE_ACP_IGNORE_EOF=1 标准输入关了也不退（收场要发信号才走）
//   FAKE_ACP_IGNORE_TERM=1 收到结束信号也不退（只能强杀）
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const log = (entry: object) => {
  const path = process.env.FAKE_ACP_LOG
  if (path) appendFileSync(path, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
}

interface Session {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string
  model: string
  effort: string
  mode: string
  history: Array<{ role: 'user' | 'agent'; text: string }>
}

const statePath = process.env.FAKE_ACP_STATE ?? ''
const sessions = new Map<string, Session>(
  statePath && existsSync(statePath)
    ? Object.entries(JSON.parse(readFileSync(statePath, 'utf8')))
    : [],
)
const persist = () => {
  if (statePath) writeFileSync(statePath, JSON.stringify(Object.fromEntries(sessions)))
}

const defaultCaps = {
  loadSession: true,
  promptCapabilities: { image: true, embeddedContext: true, audio: false },
  sessionCapabilities: { list: {}, fork: {}, resume: {} },
}

const configOptions = (session: Session) => [
  {
    id: 'model',
    name: '模型',
    category: 'model',
    type: 'select',
    currentValue: session.model,
    options: [
      { value: 'fake-small', name: '小模型' },
      { value: 'fake-large', name: '大模型', description: '慢一些' },
    ],
  },
  {
    id: 'effort',
    name: '强度',
    category: 'thought_level',
    type: 'select',
    currentValue: session.effort,
    options: [
      { value: 'low', name: '低' },
      { value: 'high', name: '高' },
    ],
  },
]
const modes = (session: Session) => ({
  currentModeId: session.mode,
  availableModes: [
    { id: 'default', name: 'Default' },
    { id: 'plan', name: 'Plan', description: '只出计划' },
  ],
})
const settings = (session: Session) => ({
  configOptions: configOptions(session),
  modes: modes(session),
})

// ---------- 线路 ----------

let nextId = 1
const waiting = new Map<number, (message: any) => void>()
const send = (message: object) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const notify = (sessionId: string, update: object) =>
  send({ method: 'session/update', params: { sessionId, update } })
const request = (method: string, params: object): Promise<any> => {
  const id = nextId++
  send({ id, method, params })
  return new Promise((resolve, reject) =>
    waiting.set(id, (message) => (message.error ? reject(message.error) : resolve(message.result))),
  )
}

// 每个会话正在跑的提示词：取消时让它以 cancelled 收尾
const cancels = new Map<string, () => void>()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const session = (params: any): Session => {
  const found = sessions.get(params?.sessionId)
  if (!found) throw { code: -32002, message: `Resource not found: ${params?.sessionId}` }
  return found
}

function create(cwd: string): Session {
  const created: Session = {
    sessionId: `fake-${sessions.size + 1}-${process.pid}-${Date.now()}`,
    cwd,
    title: null,
    updatedAt: new Date().toISOString(),
    model: 'fake-small',
    effort: 'low',
    mode: 'default',
    history: [],
  }
  sessions.set(created.sessionId, created)
  persist()
  // 和 opencode 一样，命令清单在应答之后才报
  setTimeout(
    () =>
      notify(created.sessionId, {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'review', description: '审一遍改动' },
          { name: 'init', description: '生成说明文件' },
        ],
      }),
    5,
  )
  return created
}

// ---------- 回合 ----------

const PERMISSION_OPTIONS = [
  { optionId: 'once', name: '允许一次', kind: 'allow_once' },
  { optionId: 'always', name: '总是允许', kind: 'allow_always' },
  { optionId: 'reject', name: '拒绝', kind: 'reject_once' },
]

/** 问一次权限，回选中的种类（cancelled 是取消） */
async function permit(sessionId: string, toolCall: object): Promise<string> {
  const reply = await request('session/request_permission', {
    sessionId,
    toolCall,
    options: PERMISSION_OPTIONS,
  })
  if (reply?.outcome?.outcome !== 'selected') return 'cancelled'
  return (
    PERMISSION_OPTIONS.find((option) => option.optionId === reply.outcome.optionId)?.kind ?? '?'
  )
}

async function prompt(params: any): Promise<object> {
  const current = session(params)
  const { sessionId } = current
  const text = (params.prompt as any[])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n')
  let cancelled = false
  const stopped = new Promise<void>((resolve) =>
    cancels.set(sessionId, () => {
      cancelled = true
      resolve()
    }),
  )
  const said: string[] = []
  const say = (chunk: string) => {
    said.push(chunk)
    notify(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: chunk },
    })
  }
  const [word, ...rest] = text.trim().split(/\s+/)
  const argument = rest.join(' ')
  let usage: object | undefined
  switch (word) {
    case 'hello':
      notify(sessionId, {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: '想一想' },
      })
      notify(sessionId, {
        sessionUpdate: 'plan',
        entries: [
          { content: '打招呼', priority: 'high', status: 'completed' },
          { content: '收尾', priority: 'low', status: 'in_progress' },
        ],
      })
      say('你好')
      say('，世界')
      notify(sessionId, { sessionUpdate: 'usage_update', used: 1200, size: 200000 })
      usage = { totalTokens: 1500, inputTokens: 1000, outputTokens: 500, thoughtTokens: 20 }
      break
    case 'run': {
      const toolCall = {
        toolCallId: 'call-run',
        title: 'echo hi',
        kind: 'execute',
        rawInput: { command: 'echo hi' },
      }
      notify(sessionId, { sessionUpdate: 'tool_call', ...toolCall, status: 'pending' })
      const kind = await permit(sessionId, toolCall)
      if (kind === 'cancelled' || cancelled) {
        notify(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-run',
          status: 'failed',
        })
        return { stopReason: 'cancelled' }
      }
      if (!kind.startsWith('allow')) {
        notify(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-run',
          status: 'failed',
        })
        say('不跑了')
        break
      }
      notify(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-run',
        status: 'in_progress',
      })
      const { terminalId } = await request('terminal/create', {
        sessionId,
        command: 'echo',
        args: ['hi'],
        cwd: current.cwd,
      })
      notify(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-run',
        content: [{ type: 'terminal', terminalId }],
      })
      const exit = await request('terminal/wait_for_exit', { sessionId, terminalId })
      const output = await request('terminal/output', { sessionId, terminalId })
      await request('terminal/release', { sessionId, terminalId })
      notify(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-run',
        status: 'completed',
        rawOutput: { exitCode: exit.exitCode, output: output.output },
      })
      say(`跑完了：${String(output.output).trim()}`)
      break
    }
    case 'snapshot': {
      // opencode 的做法：命令的输出每次推一整份
      const id = 'call-snap'
      notify(sessionId, {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: 'ls',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'ls' },
      })
      for (const whole of ['a\n', 'a\nb\n'])
        notify(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: id,
          content: [{ type: 'content', content: { type: 'text', text: whole } }],
        })
      notify(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: 'completed',
        rawOutput: { exitCode: 0, output: 'a\nb\n' },
      })
      say('列完了')
      break
    }
    case 'edit': {
      const toolCall = {
        toolCallId: 'call-edit',
        title: `改 ${argument}`,
        kind: 'edit',
        locations: [{ path: argument }],
      }
      notify(sessionId, { sessionUpdate: 'tool_call', ...toolCall, status: 'pending' })
      const kind = await permit(sessionId, toolCall)
      if (!kind.startsWith('allow')) {
        notify(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-edit',
          status: 'failed',
        })
        return { stopReason: kind === 'cancelled' ? 'cancelled' : 'end_turn' }
      }
      const before = await request('fs/read_text_file', { sessionId, path: argument })
        .then((result) => result.content as string)
        .catch(() => null)
      const after = `${before ?? ''}added\n`
      await request('fs/write_text_file', { sessionId, path: argument, content: after })
      notify(sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-edit',
        status: 'completed',
        content: [{ type: 'diff', path: argument, oldText: before, newText: after }],
      })
      say('改好了')
      break
    }
    case 'read': {
      const { content } = await request('fs/read_text_file', {
        sessionId,
        path: argument,
        line: 2,
        limit: 1,
      })
      say(`第二行是 ${content}`)
      break
    }
    case 'wait':
      say('等着')
      await stopped
      break
    case 'crash':
      say('要退出了')
      await sleep(20)
      process.exit(3)
      break
    case 'title':
      current.title = 'Fake 标题'
      notify(sessionId, {
        sessionUpdate: 'session_info_update',
        title: current.title,
        updatedAt: new Date().toISOString(),
      })
      say('起好了')
      break
    default:
      say(`收到：${text}`)
  }
  cancels.delete(sessionId)
  current.history.push({ role: 'user', text }, { role: 'agent', text: said.join('') })
  current.updatedAt = new Date().toISOString()
  persist()
  return cancelled
    ? { stopReason: 'cancelled' }
    : { stopReason: 'end_turn', ...(usage ? { usage } : {}) }
}

// ---------- 分派 ----------

async function handle(method: string, params: any): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: Number(process.env.FAKE_ACP_VERSION ?? 1),
        agentCapabilities: process.env.FAKE_ACP_CAPS
          ? JSON.parse(process.env.FAKE_ACP_CAPS)
          : defaultCaps,
        authMethods: [],
        agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '9.9.9' },
      }
    case 'session/new': {
      const created = create(String(params?.cwd ?? '/'))
      return { sessionId: created.sessionId, ...settings(created) }
    }
    case 'session/load': {
      const found = session(params)
      for (const entry of found.history)
        notify(found.sessionId, {
          sessionUpdate: entry.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: entry.text },
        })
      return settings(found)
    }
    case 'session/resume':
      return settings(session(params))
    case 'session/list':
      return {
        sessions: [...sessions.values()]
          .filter((entry) => entry.history.length)
          .map((entry) => ({
            sessionId: entry.sessionId,
            cwd: entry.cwd,
            title: entry.title ?? entry.history[0]?.text ?? null,
            updatedAt: entry.updatedAt,
          })),
      }
    case 'session/fork': {
      const source = session(params)
      const forked = create(source.cwd)
      forked.history = structuredClone(source.history)
      persist()
      return { sessionId: forked.sessionId, ...settings(forked) }
    }
    case 'session/set_config_option': {
      const found = session(params)
      if (params.configId === 'model') found.model = params.value
      else if (params.configId === 'effort') found.effort = params.value
      else throw { code: -32602, message: `unknown config ${params.configId}` }
      return { configOptions: configOptions(found) }
    }
    case 'session/set_mode': {
      const found = session(params)
      found.mode = params.modeId
      return {}
    }
    case 'session/prompt':
      return prompt(params)
    default:
      throw { code: -32601, message: `Method not found: ${method}` }
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  if (!line.trim()) return
  const message = JSON.parse(line)
  log({ message })
  if (message.method === undefined) {
    waiting.get(message.id)?.(message)
    waiting.delete(message.id)
    return
  }
  if (message.id === undefined) {
    if (message.method === 'session/cancel') cancels.get(message.params?.sessionId)?.()
    return
  }
  handle(message.method, message.params).then(
    (result) => send({ id: message.id, result: result ?? null }),
    (error) =>
      send({
        id: message.id,
        error: { code: error?.code ?? -32603, message: error?.message ?? String(error) },
      }),
  )
})
lines.on('close', () => {
  log({ event: 'eof' })
  if (process.env.FAKE_ACP_IGNORE_EOF !== '1') process.exit(0)
})
process.on('SIGTERM', () => {
  log({ event: 'sigterm' })
  if (process.env.FAKE_ACP_IGNORE_TERM !== '1') process.exit(0)
})
