// 客户端工具的端到端自检（不起界面、不起 Electron）：真的核心 + 主进程里那一份执行器登记表（只开 litch_echo），
// 对着真的引擎入口（scripts/client-fixture.mjs 起的隔离 Pi，模型是回环上的假模型）跑：
//   1. 建会话带上 litch_echo 的工具定义，假模型调用 echo（带一张小图），结果回到模型，模型把它原样说出来；
//      对话里那次工具调用的条目带着图片的缩略图；
//   2. echo 先问用户（ask 卡片出现在会话的请求里），答“仅这一次”之后照常回；
//   3. 再问一次，答“拒绝”，模型拿到的是 [litch:declined]。
// 用法：node dist/tools-check.mjs --entry <套接字>   本机：直接连那个入口
//       node dist/tools-check.mjs --ssh <别名>        远程：经系统的 ssh 连（LITCH_SSH_CONFIG 等由起它的脚本给）
// 每一步打一行 JSON；都对了退出码是 0。起夹具、收尾由 scripts/check-client-tools.mjs 管。
import {
  type ClientAskRequest,
  type Clock,
  createCore,
  type DeviceView,
  reduceSession,
  type SessionOp,
  type SessionView,
  type ToolCallItem,
} from '@litch/core'
import { localDevice } from '../local-adapter.mjs'
import { sshOpener } from '../transport-ssh.mjs'
import { createClientToolHost } from './host.mjs'
import { createExecutors } from './registry.mjs'
import { CLIENT_TOOL, type ClientToolToCore, type ClientToolToMain } from './types.mjs'

const clock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    return () => clearTimeout(handle)
  },
}
const began = Date.now()
const say = (line: Record<string, unknown>) =>
  console.log(JSON.stringify({ ...line, at: Date.now() - began }))
const never = { aborted: false, addEventListener() {} }

const arg = (name: string): string | null => {
  const at = process.argv.indexOf(name)
  return at < 0 ? null : (process.argv[at + 1] ?? null)
}
const entry = arg('--entry')
const alias = arg('--ssh')
if (!entry && !alias) {
  console.error('用法：tools-check --entry <套接字> | --ssh <别名>')
  process.exit(2)
}

// ---------- 主进程那一头：照 main.mts 的接法，只是消息不经进程边界 ----------
let toCore: ((message: ClientToolToCore) => void) | null = null
const host = createClientToolHost(
  createExecutors({
    platform: process.platform,
    env: { LITCH_CLIENT_TOOLS_ECHO: '1' },
    log: (line) => console.error(`[client-tools] ${line}`),
  }),
  (message) => queueMicrotask(() => toCore?.(structuredClone(message))),
)

const deviceId = alias ? 'ssh-1' : 'local'
const core = createCore({
  clock,
  version: '0.0.0-check',
  log: (line) => {
    if (process.env.LITCH_CHECK_DEBUG) console.error(`[core] ${line}`)
  },
  clientTools: {
    namespaces: () => host.namespaces(),
    post: (message) =>
      queueMicrotask(() => host.handle(structuredClone(message) as ClientToolToMain)),
    listen(handler) {
      toCore = (message) => {
        if (message.type === CLIENT_TOOL) handler(message)
      }
    },
  },
  devices: [
    alias
      ? {
          id: deviceId,
          name: alias,
          host: alias,
          kind: 'ssh',
          target: { kind: 'alias', alias },
          wire: 'orange',
          open: sshOpener({ kind: 'alias', alias }),
        }
      : {
          id: deviceId,
          name: 'local',
          host: 'local',
          kind: 'local',
          target: null,
          wire: 'green',
          open: localDevice({ entry: entry ?? '', lang: () => 'zh-CN' }).open,
        },
  ],
})

const failures: string[] = []
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what)
  say({ check: what, ok })
}

/** 等到条件成立，或者到点 */
async function until<T>(what: string, probe: () => T | null | undefined | false, ms = 60_000) {
  const end = Date.now() + ms
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() > end) throw new Error(`等不到：${what}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

/** 订阅一个会话，像界面那样把增量落到自己的一份视图上 */
function watch(sessionId: string) {
  const state = { view: null as SessionView | null }
  core.subscribe(
    { kind: 'session', deviceId, sessionId },
    {
      snapshot: (data) => {
        state.view = structuredClone(data) as SessionView
      },
      delta(ops) {
        for (const op of ops as SessionOp[]) {
          if (state.view) reduceSession(state.view, structuredClone(op))
        }
      },
      error: (error) => say({ sessionError: String(error.message) }),
    },
  )
  return state
}

const agentTexts = (view: SessionView | null): string[] =>
  Object.values(view?.items ?? {}).flatMap((item) =>
    item.kind === 'agentMessage' ? [item.text] : [],
  )
const settled = (view: SessionView | null) =>
  view !== null && view.turns.length > 0 && view.turns.every((turn) => turn.status !== 'running')

async function main() {
  let device: DeviceView | null = null
  core.subscribe(
    { kind: 'app' },
    {
      snapshot: (data) => {
        device = (data as { devices: DeviceView[] }).devices[0] ?? null
      },
      delta(ops) {
        for (const op of ops as { op: string; device?: DeviceView }[]) {
          if (op.op === 'device.upsert' && op.device) device = op.device
        }
      },
      error() {},
    },
  )
  core.start()
  await until('设备连上', () => (device as DeviceView | null)?.connection === 'online', 90_000)
  say({
    connected: (device as DeviceView | null)?.mode,
    harnesses: (device as DeviceView | null)?.harnesses.map((h) => h.id),
  })

  // 1. 建会话带工具，模型调 echo 并要一张图，结果回到模型
  const { sessionId } = (await core.command(
    'session.create',
    { deviceId, cwd: null, text: '回声 LITCH-ECHO-1 要图' },
    never,
  )) as { sessionId: string }
  const session = watch(sessionId)
  await until(
    '第一次回声的回话',
    () =>
      agentTexts(session.view).some((text) => text.includes('LITCH-ECHO-1')) &&
      settled(session.view),
  )
  const said = agentTexts(session.view).join('\n')
  check(said.includes('回声结果：LITCH-ECHO-1（带图）'), '结果（文字和图片）回到了模型')
  const tool = Object.values(session.view?.items ?? {}).find(
    (item): item is ToolCallItem => item.kind === 'toolCall' && item.source === 'litch_echo',
  )
  check(tool?.status === 'completed', '对话里有这次工具调用，已完成')
  check(
    tool?.output.some((part) => part.kind === 'blob' && part.src?.startsWith('data:image/png')) ===
      true,
    '工具条目里的图片留着缩略图',
  )

  // 2. 先问用户，答“仅这一次”
  await core.command('session.send', { deviceId, sessionId, text: '回声 LITCH-ECHO-2 先问' }, never)
  const card = (await until('ask 卡片', () =>
    session.view?.requests.find((request) => request.kind === 'clientAsk'),
  )) as ClientAskRequest
  check(
    card.ask.kind === 'site' && card.device.kind === (alias ? 'ssh' : 'local'),
    'ask 卡片标着设备和网站',
  )
  await core.command(
    'session.respond',
    { deviceId, sessionId, requestId: card.id, optionId: 'once' },
    never,
  )
  await until(
    '第二次回声的回话',
    () =>
      agentTexts(session.view).some((text) => text.includes('回声结果：LITCH-ECHO-2')) &&
      settled(session.view),
  )
  check(session.view?.requests.length === 0, '答了之后卡片撤掉')

  // 3. 再问一次，答“拒绝”
  await core.command('session.send', { deviceId, sessionId, text: '回声 LITCH-ECHO-3 先问' }, never)
  const again = (await until('第二张 ask 卡片', () =>
    session.view?.requests.find((request) => request.kind === 'clientAsk'),
  )) as ClientAskRequest
  await core.command(
    'session.respond',
    { deviceId, sessionId, requestId: again.id, optionId: 'decline' },
    never,
  )
  await until(
    '拒绝之后的回话',
    () =>
      agentTexts(session.view).some((text) => text.includes('[litch:declined]')) &&
      settled(session.view),
  )
  check(true, '拒绝之后模型拿到 [litch:declined]')
}

main()
  .catch((error: unknown) => {
    failures.push(String(error instanceof Error ? error.message : error))
    say({ error: String(error) })
  })
  .finally(() => {
    core.stop()
    host.reset()
    say({ done: true, ok: failures.length === 0, failures })
    setTimeout(() => process.exit(failures.length === 0 ? 0 : 1), 200)
  })
