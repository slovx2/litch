// 开发和自检用的小工具：不起界面，拿本机设备的打开方式连一次，把走过的每一步和最后的结果各打一行 JSON。
// 自检脚本（scripts/check-adapter.mjs）拿它对着假的适配器把每一种情形过一遍。
//
// 用法：node dist/adapter-check.mjs [--timeout 毫秒] [--abort-after 毫秒]
//   认的环境变量和核心进程是同一组：LITCH_ENTRY、LITCH_ADAPTER_ROOT、LITCH_ADAPTER_HOME，
//   语言看 LITCH_LANG（核心进程里它是界面还没报语言时的默认值）。
//   默认：打开传输、握手、列一次会话，然后断开。连上了退出码是 0，没连上是 1。只试一次，不等它自己重连。
//   结果那一行里 upgrade 是外壳自己记的换版本结果，view 是界面最后看到的那一份：外壳交给核心的
//   （local-adapter.mts 的 upgradeReport）经核心挑过（projectUpgrade）之后放进设备显示数据里的样子。
//   --timeout：等设备服务起来最多等多久（验超时用）。
//   --abort-after：过这么久就放弃这次连接（验“取消了不留下等待中的命令”用）。
//   --shell-timeout：问登录 shell（环境变量 SHELL）最多等多久（验“shell 不返回也照样启动”用）。
//   --stop-timeout：换版本时等 device-stop 最多等多久（验“停不下来也照样连上旧的”用）。
//   --reopen：连上、打完结果之后再打开一次本机设备的传输（不握手，开了就关），把这一次的结果打成 {"reopened": …}。
//     验的是同一次运行里第二次打开时的处理：换不了的那份服务不再去打扰它，不闲的再问一遍。
//   --compare <JSON>：不连任何东西，只把版本比较的规则过一遍（adapter-upgrade.mts），打一行 JSON 就退出。
//     给的是 {"versions":[[甲,乙],…],"services":[[在跑的来历或 null, 自带的来历],…]}，
//     打出来的是同样形状的结论：versions 里每一对是 -1、0、1 或 null，services 里每一对是 older、same 之类。
// 连上之后还可以多做两件事（scripts/check-local.mjs 拿它们对着真的适配器验一遍），各打一行 JSON，都排在最后那行结果之前：
//   --info：调一次 runtime/info，应答原样打成 {"info": …}。对面是聚合面时里面是这台设备和各 harness 可不可用、为什么不可用
//   --turn <harness>：在这个 harness 上新建一个会话、发一句话、等这个回合结束，打成 {"turn": …}，
//     里面有回话的原文、回话里有没有带着发出去的那一句（隔离环境里的假模型会把收到的话带回来）、用了多久
//     --say <话>             发哪一句，不给就发一句带时间的
//     --cwd <目录>           会话的工作目录，不给就是当前目录
//     --model <模型>         新建会话时指定的模型，不给就用对面默认的
//     --turn-timeout <毫秒>  等回合结束最多等多久，默认 60000
import { type Clock, createLink, describeText, projectUpgrade } from '@litch/core'
import {
  compareService,
  compareVersions,
  parseCliFacts,
  parseServiceFacts,
} from './adapter-upgrade.mjs'
import { localDevice, upgradeReport } from './local-adapter.mjs'
import { loginEnvironment } from './login-env.mjs'

const clock: Clock = {
  now: () => Date.now(),
  setTimer(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    return () => clearTimeout(handle)
  },
}

const say = (line: Record<string, unknown>) => console.log(JSON.stringify(line))

/** 命令行里 `--名字 数` 的那个数 */
const numberOf = (name: string): number | undefined => {
  const at = process.argv.indexOf(name)
  const value = at > 0 ? Number(process.argv[at + 1]) : Number.NaN
  return Number.isFinite(value) ? value : undefined
}

/** 命令行里 `--名字 值` 的那个值 */
const textOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at > 0 ? process.argv[at + 1] : undefined
}

/** 回合通知里这里用得到的那几个字段。只认这几样，别的不看 */
interface TurnEvent {
  threadId?: string
  delta?: string
  item?: { type?: string; text?: string }
  turn?: { id?: string; status?: string; error?: { message?: string } | null }
}

/** 正等着回合通知的那一方。没有回合在跑时是 null，通知直接丢掉 */
let onTurnEvent: ((method: string, event: TurnEvent) => void) | null = null

/** 在指定的 harness 上新建一个会话、发一句话、等这个回合结束 */
async function runTurn(harness: string): Promise<Record<string, unknown>> {
  const text = textOf('--say') ?? `自检发的一句话 ${new Date().toISOString()}`
  const model = textOf('--model')
  // 聚合面上新建会话要指明在哪个 harness 上；握手时已经声明了这项扩展
  const start = {
    harness,
    cwd: textOf('--cwd') ?? process.cwd(),
    ...(model ? { model } : {}),
  }
  const { thread } = await link.request('thread/start', start)
  const timeoutMs = numberOf('--turn-timeout') ?? 60_000
  const sentAt = Date.now()
  let firstDeltaMs: number | null = null
  let streamed = ''
  let reply: string | null = null
  const finished = new Promise<NonNullable<TurnEvent['turn']>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`等了 ${timeoutMs} 毫秒，回合还没有结束`)),
      timeoutMs,
    )
    onTurnEvent = (method, event) => {
      if (event.threadId !== thread.id) return
      if (method === 'item/agentMessage/delta') {
        firstDeltaMs ??= Date.now() - sentAt
        streamed += event.delta ?? ''
      } else if (method === 'item/completed' && event.item?.type === 'agentMessage') {
        reply = event.item.text ?? ''
      } else if (method === 'turn/completed') {
        clearTimeout(timer)
        resolve(event.turn ?? {})
      }
    }
  })
  try {
    await link.request('turn/start', {
      threadId: thread.id,
      input: [{ type: 'text', text, text_elements: [] }],
    })
    const turn = await finished
    // 定稿的那一条没来就用攒下的增量：两样都没有才是真的没回话
    const said = reply ?? streamed
    return {
      harness,
      threadId: thread.id,
      turnId: turn.id ?? null,
      status: turn.status ?? null,
      error: turn.error?.message ?? null,
      sent: text,
      reply: said,
      echoed: said.includes(text),
      streamed: streamed.length > 0,
      firstDeltaMs,
      tookMs: Date.now() - sentAt,
    }
  } finally {
    onTurnEvent = null
  }
}

const done = (code: number) => {
  link.stop()
  // 留一点时间让被结束的子进程收尾
  setTimeout(() => process.exit(code), 300)
}

/** 只过一遍版本比较的规则，不连任何东西 */
const comparing = textOf('--compare')
if (comparing !== undefined) {
  const given = JSON.parse(comparing) as { versions?: [string, string][]; services?: unknown[][] }
  say({
    versions: (given.versions ?? []).map(([left, right]) => compareVersions(left, right)),
    services: (given.services ?? []).map(([running, bundled]) => {
      const cli = parseCliFacts(bundled)
      return cli ? compareService(parseServiceFacts(running), cli) : null
    }),
  })
  process.exit(0)
}

const local = localDevice({
  entry: process.env.LITCH_ENTRY,
  adapterRoot: process.env.LITCH_ADAPTER_ROOT,
  adapterHome: process.env.LITCH_ADAPTER_HOME,
  lang: () => (process.env.LITCH_LANG === 'en' ? 'en' : 'zh-CN'),
  environment: () => loginEnvironment(process.env.SHELL, numberOf('--shell-timeout')),
  startTimeoutMs: numberOf('--timeout'),
  stopTimeoutMs: numberOf('--stop-timeout'),
})

/**
 * 界面看到的换版本结果，走的是和应用里一样的两步：外壳交出去（upgradeReport），核心挑过再放进设备的显示数据
 * （projectUpgrade）。没有换版本这回事（走的是另外指定的入口）是 null
 */
const viewOf = () => projectUpgrade(upgradeReport(local))

/** 再打开一次本机设备的传输，开了就关，返回这一次的结果 */
async function reopen(): Promise<Record<string, unknown>> {
  const transport = await local.open({ aborted: false, addEventListener() {} })
  transport.close()
  return {
    last: local.last(),
    launched: local.launched(),
    upgrade: local.upgrade(),
    view: viewOf(),
  }
}

const link = createLink({
  open: local.open,
  clock,
  clientInfo: { name: 'litch-adapter-check', title: 'Litch', version: '0.0.0' },
  notification(method, params) {
    if (params && typeof params === 'object') onTurnEvent?.(method, params as TurnEvent)
  },
  state(state) {
    if (state.phase === 'connecting' && state.step) {
      say({ step: describeText(state.step) })
    } else if (state.phase === 'waiting' || state.phase === 'failed') {
      say({
        result: 'failed',
        stage: state.failure.stage,
        text: describeText(state.failure.text),
        detail: state.failure.detail,
        retriable: state.phase === 'waiting',
      })
      done(1)
    } else if (state.phase === 'connected') {
      const connectMs = Date.now() - startedAt
      const extras = async () => {
        // 聚合面上这个方法的应答和单个运行时的形状不一样，这里不挑字段，原样打出来
        if (process.argv.includes('--info')) say({ info: await link.request('runtime/info', {}) })
        const harness = textOf('--turn')
        if (harness) say({ turn: await runTurn(harness) })
      }
      extras()
        .then(() => link.request('thread/list', { limit: 100 }))
        .then(async (list) => {
          say({
            result: 'ok',
            userAgent: state.info.userAgent,
            threads: list.data.length,
            // 列出来的会话各是谁的。harness 只有聚合面会打上，单个入口上是 null
            sessions: list.data.map((thread) => ({
              id: thread.id,
              harness: (thread as { harness?: string }).harness ?? null,
            })),
            // 从开始连到握手完成用了多久：问登录 shell、device-start（服务不在时含拉起它）、握手都在里面
            connectMs,
            // 命令行报回来的：服务是不是这次拉起的、常驻进程的进程号
            last: local.last(),
            launched: local.launched(),
            // 在跑的服务和自带的是不是同一版、换了没有、没换是因为什么
            upgrade: local.upgrade(),
            // 同一件事到了界面上的样子
            view: viewOf(),
          })
          if (process.argv.includes('--reopen')) say({ reopened: await reopen() })
          done(0)
        })
        .catch((error: unknown) => {
          say({ result: 'failed', stage: 'request', text: String(error) })
          done(1)
        })
    }
  },
})
const startedAt = Date.now()
link.start()

const abortAfter = numberOf('--abort-after')
if (abortAfter !== undefined) {
  setTimeout(() => {
    say({ result: 'aborted' })
    done(0)
  }, abortAfter)
}
