// 模拟核心：不连任何设备，拿示例数据实现核心对通道的两个入口。
// 界面开发、组件测试、桌面外壳的自检都对着它跑。
// 它会把回答按小块流出来，发送、排队、打断、审批、提问也都有个样子，让界面的每条路径真的被走到。

import type { ThreadItem } from '../../../protocol/src/index.mjs'
import {
  ChannelError,
  type Clock,
  type Commands,
  type SessionOp,
  type SidebarOp,
  type Topic,
} from '../channel/protocol.mjs'
import type { CoreHost, HostSink } from '../channel/server.mjs'
import {
  changeToolSwitches,
  checkTarget,
  defaultName,
  hostLabel,
  type SavedToolSwitches,
  sameTarget,
  toolSwitchesOf,
  WIRES,
} from '../device/remote.mjs'
import type {
  AppView,
  ConnectFailureView,
  DeviceView,
  HarnessView,
  ItemView,
  OutgoingMessage,
  QuestionView,
  RemoteCheck,
  RemoteTarget,
  SessionAbilities,
  SessionAbility,
  SessionSummary,
  SessionView,
  SidebarView,
  TodoStep,
} from '../model.mjs'
import type { TerminalsAlive } from '../model-terminal.mjs'
import type { SessionEventView } from '../model-tree.mjs'
import { phrase } from '../phrase.mjs'
import { projectItem } from '../projection/items.mjs'
import { localUserMessage, outgoing } from '../projection/outgoing.mjs'
import { settleAnswers } from '../projection/questions.mjs'
import { reduceSession } from '../projection/reduce.mjs'
import { spanOp } from '../projection/span.mjs'
import { settleSteps, todoKey } from '../projection/todo.mjs'
import { createMockApprovals } from './mock-approvals.mjs'
import { createMockOrganize } from './mock-arrange.mjs'
import { createMockBackground } from './mock-background.mjs'
import { createMockCompose } from './mock-compose.mjs'
import { createMockConfig, RUNS_CONFIG } from './mock-config.mjs'
import { createMockDiffs } from './mock-diffs.mjs'
import { createMockFiles } from './mock-files.mjs'
import { createMockGoal } from './mock-goal.mjs'
import { createMockHarnessConfig } from './mock-harness-config.mjs'
import { createMockInstall } from './mock-install.mjs'
import { mockAccountLimits } from './mock-limits.mjs'
import { createMockMachine } from './mock-machine.mjs'
import { createMockManagement } from './mock-manage.mjs'
import { createMockPairing } from './mock-pairing.mjs'
import { createMockPeer } from './mock-peer.mjs'
import { createMockRemoteUpgrade } from './mock-remote-upgrade.mjs'
import { createMockService } from './mock-service.mjs'
import { createMockTasks } from './mock-tasks.mjs'
import { createMockTerminals } from './mock-terminals.mjs'
import { createMockTree } from './mock-tree.mjs'
import { createMockWorktrees, shownOf } from './mock-worktrees.mjs'
import {
  type ClientToolDemo,
  clientAskRequest,
  clientToolCall,
  type SignInDemo,
} from './sample-client-tools.mjs'
import { ASKS_COMMENTABLE, commentSample, commentsReply } from './sample-comments.mjs'
import { PI_PLAN_QUESTION, samplePlan } from './sample-compose.mjs'
import {
  SAMPLE_HOSTS,
  STREAM_SESSION,
  sampleApp,
  sampleArchived,
  sampleDefaults,
  sampleOptions,
  sampleQuestions,
  sampleSession,
  sampleSettings,
  sampleSidebars,
  streamText,
} from './sample-data.mjs'
import { sampleHarness, takesNote } from './sample-harness.mjs'
import {
  type MachineDemo,
  machineAskRequest,
  machineDemoAsk,
  machineSummary,
  machineToolCall,
  sampleMachineAccess,
} from './sample-machine.mjs'
import { ASKS_REPORT, readCall, reportSample } from './sample-report.mjs'
import { sampleRemoteService } from './sample-service.mjs'
import { sampleTaskAnswer } from './sample-tasks.mjs'
import { SAMPLE_TEXT, type SampleLang } from './sample-text.mjs'
import { dumpCall, shotsCall } from './sample-tools.mjs'

export interface MockCoreOptions {
  clock: Clock
  version?: string
  /** 流式回答每一小块之间隔多久，默认 60 毫秒。设成 0 表示不流，一开始就是完整的 */
  chunkMs?: number
  /** 示例数据用哪种语言，默认中文 */
  lang?: SampleLang
  /** 扫码绑定手机的码多久作废，默认和真的一样十分钟（验收里试“到期自动换码”时调短） */
  pairTtlMs?: number
  /**
   * 演哪一种开局。fresh：刚装好 Litch 的电脑，本机一个 harness 都没装（试首启引导、一键安装）。
   * 不给是平常那一套示例
   */
  scene?: 'fresh'
}

const topicKey = (topic: Extract<Topic, { kind: 'app' | 'sidebar' | 'session' }>): string =>
  topic.kind === 'app'
    ? 'app'
    : topic.kind === 'sidebar'
      ? `sidebar:${topic.deviceId}`
      : `session:${topic.deviceId}:${topic.sessionId}`

/** 发的话里带这些字样时，模拟的回合会先停下来要一次审批。给界面试审批卡片用 */
const ASKS_APPROVAL = /审批|approval/i

/**
 * 没有声明的 harness 不会哪件事（示例里是直接连的那台原生 codex，假装它是个旧版本）。
 * 和真的一样，事先不知道：第一次去做的时候对面说不认识，这才记下来，之后它的会话上那个入口就停了。
 * 有声明的 harness 不走这里：照它的声明，不会的入口界面一开始就不出。
 */
const MOCK_LACKS: Record<string, readonly SessionAbility[]> = { codex: ['fork', 'compact'] }

/**
 * 开局 fresh：刚装好 Litch 的电脑，本机的 harness 一个都没装（首启引导的第一步“先装一个”）。
 * 远程设备照旧：引导只看本机
 */
const freshLocal = (app: AppView): void => {
  const local = app.devices.find((device) => device.kind === 'local')
  if (!local) return
  local.harnesses = local.harnesses.map((harness) =>
    sampleHarness(harness.id, {
      down: {
        kind: 'notInstalled',
        reason: 'harness.notInstalled',
        detail: {
          'zh-CN': `在 PATH 和常见的安装位置里都没有找到 ${harness.name}`,
          en: `${harness.name} was not found on PATH or in the usual install locations`,
        },
      },
    }),
  )
}

/**
 * 发的话里带这些字样时，演一出“别的客户端整理了这台设备的侧栏”：过一会儿这个会话被置顶了，
 * 还多出一个工作区。给界面试“别处改了，这边不刷新也看得到”用。
 */
const ORGANIZES_ELSEWHERE = /别处整理|organize elsewhere/i

/** 发的话里带这些字样时，回答里带一张 mermaid 图和一张画不出来的。给界面试画图、切源码、语法错时退回源码用 */
const DRAWS = /画图|draw a diagram/i

/** 发的话里带这些字样时，回答里带着几种写法的文件路径。给界面试“对话里的路径可以点开”用 */
const SHOWS_FILES = /看文件|show files/i

/**
 * 发的话里带这些字样时，模拟的回合会“改文件”：在会话的工作目录里改一个文件、新加一个文件，对话里出一条
 * “改了文件”。给界面试“代理改完，回合结束后差异面板自己跟上”用。
 * 说的是“改大文件”时另外再新写一个六百行的：对话里那一处长得不展开，只给去差异面板的入口
 */
const EDITS_FILES = /改大?文件|edit (files|a big file)/i
const EDITS_BIG = /改大文件|edit a big file/i

/** 发的话里带这些字样时，模拟的回合会先列一份待办，一步一步做完再回话。给界面试待办进度用 */
const LISTS_TODOS = /待办|todo/i

/** 新建会话的第一句话里带这些字样时，会话建不成。给界面试“没建成，写的字还回输入框”用 */
const REFUSES_CREATE = /建不成|refuse to create/i

/**
 * 发的话里带这些字样时，模拟的回合会停下来提问，答完把收到的回答带在回话前面。给界面试提问的向导用：
 * - 提问：一次问三道（示例里那一份：单选、自己写、单选）；
 * - 问一句：只问一道单选题，没有“其他”——只有一道题的请求选了就交。
 */
const ASKS_QUESTIONS = /提问|ask questions/i
const ASKS_ONE = /问一句|ask one/i

/**
 * 发的话里带“跑一会儿”时，回合里先跑一条不出输出的命令，两秒多之后结束，再照常回话。
 * 对面不增量给输出的时候，界面靠那一行上“已经跑了多久”让人看出它还活着——给这个用。
 */
const RUNS_A_WHILE = /跑一会儿|run a while/i
/** “跑一会儿”那条命令跑多久。按真的时间走，不跟着出字的快慢变：界面上的秒数要来得及跳 */
const RUN_MS = 2400
/**
 * 发的话里带“边做边问”时，回合里先来一条带题的助手消息（codex 的 request_user_input_async：
 * 工具当场回“收到”，模型不停下来），接着跑一条命令，ASK_RUN_MS 之后结束、照常回话。
 * 给界面试对话里的问题卡片用：回合还在跑的时候答，答复直接插进这个回合
 */
const ASKS_WHILE_WORKING = /边做边问|ask while working/i
const ASK_RUN_MS = 8000
/**
 * 发的话里带“想一会儿”时，回合开头先空等 RUN_MS 什么都不出（等第一个字），出一段说明之后再空等一次
 * （两段输出之间），再照常回话。给界面试回合末尾那一行“正在工作”：它只在这种空档里出现
 */
const THINKS_A_WHILE = /想一会儿|think a while/i
/**
 * 发的话里带“推理一会儿”时，回合开头先空等 RUN_MS（等第一个字），接着来一条思考，按真的时间慢慢出字、
 * 过 REASON_MS 结束，再照常回话。给界面试“正在工作”那一个提示：空档里在末尾，思考时换到思考所在的那一行
 */
const REASONS_A_WHILE = /推理一会儿|reason a while/i
/** “推理一会儿”那条思考写多久：比出字慢得多，界面上来得及点开、截图 */
const REASON_MS = 6000
/**
 * 发的话里带“忙一阵”时，回合里按真的时间来一串过程：几条很快跑完的命令、读一个文件、一段思考、一段说明，
 * 每两步之间停 BUSY_GAP_MS（模型在想下一步），最后照常回话。给界面试回合末尾那一行“正在工作”：
 * 命令、工具、思考来来去去时它一直在，只有正文出字时隐去
 */
const KEEPS_BUSY = /忙一阵|keep busy/i
const BUSY_GAP_MS = 900
/** “忙一阵”里每条命令、工具跑多久：真的命令常常一百毫秒上下就完 */
const BUSY_STEP_MS = 150
/** “忙一阵”里的条目标识带这个前缀，回合被打断时还在跑的记成没成 */
const busyKey = (turnId: string, n: number): string => `${turnId}-b${n}`
/** “跑一会儿”那条命令的条目标识 */
const runKey = (turnId: string): string => `${turnId}-w`

/**
 * 发的话里带“狂打日志”时，回合里跑一条狂打日志的命令：按真的时间每一拍来几段输出（一段 8 KB，上游 codex 也是这么切的），
 * 一共 FLOOD_BYTES，打完结束，再照常回话。给界面试“命令输出很长时只留头尾、中间标出省了多少”用：
 * 核心和界面里留着的输出不随它涨，展开着看也不卡。条目标识和“跑一会儿”是同一个，被打断时一样记成没成
 */
const FLOODS = /狂打日志|flood the log/i
/**
 * “猛打日志”（英文 burst the log）是同一条命令打得快八倍：每一拍 64 段（512 KB），一秒上下打完 24 MB，
 * 和一条快的命令（cat 一个大文件）一口气打出来一样。给“一帧里来几百 KB 时通道只发头尾”用
 */
const BURSTS = /猛打日志|burst the log/i
const BURST_PER_TICK = 64
const FLOOD_BYTES = 24 * 1024 * 1024
const FLOOD_CHUNK = 8 * 1024
const FLOOD_PER_TICK = 8
const FLOOD_TICK_MS = 16
export const FLOOD_COMMAND = 'npm run build -- --verbose'

/**
 * 发的话里带“工具大结果”时，回合里先后调两次结果很大的工具，再照常回话（两次调用的样子在 sample-tools.mts）：
 * 一次 MCP 工具回 20 MB 上下的文字夹一张 2 MB 的图，一次动态工具回三千段文字和三千张小图。
 * 和真的对面一样，开始时没有结果，过 TOOL_MS 整段给；给界面试“工具结果很长时只留头尾、图片只写一行说明”用。
 * 第一次的条目标识和“跑一会儿”是同一个，第二次的另起一个，被打断时都记成没成
 */
const HUGE_TOOLS = /工具大结果|huge tool result/i
const TOOL_MS = 600
const toolKey = (turnId: string): string => `${turnId}-w2`

/**
 * 发的话里带这些字样时，演一次客户端工具调用：回合里出一条工具条目，停下来出一张“要你批准”的卡片
 * （和审批卡片同一处），答应了条目带着一张截图完成、拒绝了条目失败，再照常回话。
 * - 用浏览器：内置浏览器要打开一个没去过的网站（这一次 / 这个会话 / 一直 / 拒绝）；
 * - 操作应用：Computer Use 要操作一个高风险的应用。远程设备上的会话没有“始终允许”，卡片上标着来自哪台设备。
 * 条目标识和“工具大结果”的第二次是同一个，被打断时一样记成没成
 */
const BROWSES = /用浏览器|use the browser/i
const USES_APP = /操作应用|use an app/i

/**
 * 发的话里带“登录网站”时，演一次代理请人登录（request_sign_in）：对话里出登录卡片。再带“没账号”是库里没有这个网站的账号，
 * 带“预检”是页面不能代填（http），带“定时”是定时任务的回合（多一个勾选、30 分钟过期）。
 * 模拟核心里没有外壳，卡片只能拒绝
 */
const SIGNS_IN = /登录网站|sign in to a site/i

const signInDemo = (text: string): SignInDemo =>
  /没账号|no account/i.test(text)
    ? 'signInNone'
    : /预检|blocked/i.test(text)
      ? 'signInBlocked'
      : /定时|scheduled/i.test(text)
        ? 'signInTask'
        : 'signIn'

/**
 * 发的话里带这些字样时，演一次远程设备操作这台电脑（litch_machine）：回合里出一条工具条目，
 * 按这台设备的开关和审批方式走——关着当场失败；不确认直接做；要问就停下来出一张卡片，拒绝能附一句理由。
 * - 在我电脑上跑：起一个不会自己结束的开发服务器，允许了之后顶栏里多一个进程；
 * - 看我的 ssh：命令里提到禁止位置，卡片标红，已经“本会话都允许”了也再问；
 * - 搬到我电脑：把远程的一个文件搬到这台电脑。
 * 另有“命令行来的”（mock-machine.mts 的 MACHINE_CLI）：在全局待处理里加一张卡片，回合照常往下走。
 */
const MACHINE_ASKS: [RegExp, MachineDemo][] = [
  [/在我电脑上跑|run on my computer/i, 'exec'],
  [/看我的 ?ssh|peek at my ssh/i, 'flagged'],
  [/搬到我电脑|copy to my computer/i, 'copy'],
]

/** 狂打的日志里的第 n 行。行里带着序号，看得出头尾各是哪几行 */
const floodLine = (n: number): string =>
  `[${String(n).padStart(7, '0')}] compiling src/module-${n % 997}.ts … ok\n`

/**
 * 发的话里带这些字样时，这个会话所属的 harness 掉线一会儿再回来（只在有多个 harness 的设备上）。
 * 给界面试“一个 harness 不可用，别的照常”用：掉线期间它的会话发不了消息，回来之后那个回合记成中断。
 */
const DROPS_HARNESS = /掉线|go offline/i

/**
 * 发的话里带这些字样时，演一出“别的客户端也在管这台设备”（只在能管理的设备上）。给界面试设置的冲突用：
 * - 别处改设置：等这台设备的详情打开之后过一会儿，别处改了两项设置（这个会话所属 harness 的入口端口、
 *   终端保留多久），这边收到通知；
 * - 抢先改设置：别处抢先改了同样这两项，通知却没到这边——这边下一次保存会得到冲突；
 * - 加一项设置：设备服务多了一项设置（相当于它升级了），界面不用改就该看得到、改得了。
 */
const EDITS_ELSEWHERE = /别处改设置|settings elsewhere/i
const RACES_SETTINGS = /抢先改设置|race the settings/i
const ADDS_SETTING = /加一项设置|add a setting/i

/**
 * harness 详情设置的两出别处的动静（mock-harness-config.mts）：
 * - 别处改配置：等这台设备上有 harness 的详情设置开着之后过一会儿，别处改了一项配置，这边收到通知；
 * - 抢先改配置：别处抢先改了，通知没到——这边下一次带版本的保存会冲突、重读
 */
const EDITS_CONFIG_ELSEWHERE = /别处改配置|config elsewhere/i
const RACES_CONFIG = /抢先改配置|race the config/i
/**
 * 模型清单的两出（只对有模型清单的 Codex）：
 * - 别处改模型清单：过一会儿别处改了这台设备上 Codex 的模型清单，这边收到通知（有草稿时提示“被别处改过”）；
 * - 锁住模型清单：管理员把清单锁住了（再说一次解开），界面只能看
 */
const EDITS_MODELS_ELSEWHERE = /别处改模型清单|models elsewhere/i
const LOCKS_MODELS = /锁住模型清单|lock the model list/i

/** 把文本切成 2 到 6 个字的小块，模拟模型一点点吐字。scale 是倍数：英文一个词好几个字母，块要大一些 */
export function chunkText(text: string, scale = 1): string[] {
  const chars = Array.from(text)
  const chunks: string[] = []
  for (let i = 0, n = 0; i < chars.length; n++) {
    const size = (2 + ((n * 7) % 5)) * scale
    chunks.push(chars.slice(i, i + size).join(''))
    i += size
  }
  return chunks
}

/** 模拟核心另外带着退出应用时要问的那两样，和真的核心同名 */
export interface MockCore extends CoreHost {
  terminalsAlive(): TerminalsAlive
  endTerminals(): Promise<void>
}

export function createMockCore(options: MockCoreOptions): MockCore {
  const { clock } = options
  const chunkMs = options.chunkMs ?? 60
  const lang = options.lang ?? 'zh-CN'
  const app: AppView = sampleApp(lang, clock.now())
  if (options.scene === 'fresh') freshLocal(app)
  const sidebars = new Map<string, SidebarView>(
    sampleSidebars(clock.now(), lang).map((view) => [view.deviceId, view]),
  )
  /** 各设备上已归档的会话。界面要了才放进侧栏的数据里 */
  const shelved = sampleArchived(clock.now(), lang)
  const sessions = new Map<string, SessionView>()
  const sinks = new Map<string, Set<HostSink>>()
  /** 各会话里正在流的回答：取消函数。打断时用 */
  const replies = new Map<string, () => void>()
  /** 正在流的回答落在哪个回合的哪个条目上 */
  const replyItems = new Map<string, { turnId: string; itemId: string }>()
  let seq = 0
  let streaming: 'idle' | 'running' | 'done' = 'idle'
  /** 取消流式的下一步。复位时用 */
  let stopStream: (() => void) | null = null

  const streamKey = `session:${STREAM_SESSION.deviceId}:${STREAM_SESSION.sessionId}`

  /** 和真的核心一样：现在用不了、而侧栏里还留着它上次的会话的 harness */
  const strandedOf = (deviceId: string, harnesses: HarnessView[]): string[] => {
    const owners = new Set(
      (sidebars.get(deviceId)?.sessions ?? []).map((session) => session.harness),
    )
    return harnesses
      .filter((entry) => entry.state !== 'ready' && owners.has(entry.id))
      .map((entry) => entry.id)
  }
  for (const device of app.devices) {
    if (device.connection === 'online') {
      device.stranded = strandedOf(device.id, device.harnesses)
    }
  }

  const emit = (key: string, ops: unknown[]) => {
    for (const sink of sinks.get(key) ?? []) sink.delta(ops)
  }

  /** 已归档的那张表变了。界面要过的才通知 */
  const archivedChanged = (deviceId: string) => {
    const view = sidebars.get(deviceId)
    if (!view || view.archived === null) return
    view.archived = [...(shelved.get(deviceId) ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
    const ops: SidebarOp[] = [{ op: 'archived.set', sessions: view.archived }]
    emit(`sidebar:${deviceId}`, ops)
  }

  const isShelved = (deviceId: string, sessionId: string): boolean =>
    (shelved.get(deviceId) ?? []).some((session) => session.id === sessionId)

  /** 会话的摘要。归档着的也找得到：它们的内容可以只读地打开看 */
  const findSummary = (deviceId: string, sessionId: string): SessionSummary => {
    const summary =
      sidebars.get(deviceId)?.sessions.find((session) => session.id === sessionId) ??
      shelved.get(deviceId)?.find((session) => session.id === sessionId)
    if (!summary) throw new ChannelError('notFound', `没有这个会话：${deviceId}/${sessionId}`)
    return summary
  }

  const updateSummary = (deviceId: string, sessionId: string, patch: Partial<SessionSummary>) => {
    const view = sidebars.get(deviceId)
    const index = view?.sessions.findIndex((session) => session.id === sessionId) ?? -1
    if (!view || index < 0) return
    const next = { ...(view.sessions[index] as SessionSummary), ...patch }
    view.sessions[index] = next
    const ops: SidebarOp[] = [{ op: 'session.upsert', session: next }]
    emit(`sidebar:${deviceId}`, ops)
  }

  /** 已经“发现”不会的事：设备 + harness + 哪件事，冒号隔开 */
  const lacking = new Set<string>()

  /** 和真的核心一样：有声明照声明，没有声明先当它都会；试过不行的两种情况下都算不会 */
  const canOf = (deviceId: string, harness: string): SessionAbilities => {
    const declared = harnessOn(deviceId, harness)?.abilities ?? null
    const can = (ability: SessionAbility): boolean =>
      (declared ? declared[ability] : true) && !lacking.has(`${deviceId}:${harness}:${ability}`)
    return {
      fork: can('fork'),
      rollback: can('rollback'),
      compact: can('compact'),
      steer: can('steer'),
      steerImages: declared ? declared.steerImages : true,
      cutInTurn: declared?.cutInTurn === true,
      rollbackRestoresFiles: declared ? declared.rollbackRestoresFiles : false,
      finalOnStart: declared ? declared.finalOnStart : false,
      backgroundTasks: declared ? declared.backgroundTasks : false,
      goals: declared?.goals === true && !lacking.has(`${deviceId}:${harness}:goals`),
      declared: declared !== null,
    }
  }

  /**
   * 这个会话所属的 harness 会不会这件事。声明了不会的直接报“不支持”；
   * 没有声明又确实不会的：记下来，告诉它上面开着的会话，然后报“不支持”
   */
  const attempt = (view: SessionView, ability: SessionAbility) => {
    const declared = harnessOn(view.deviceId, view.harness)?.abilities
    if (declared) {
      if (declared[ability]) return
      throw new ChannelError('unsupported', '对面不支持这个操作')
    }
    if (!MOCK_LACKS[view.harness]?.includes(ability)) return
    const key = `${view.deviceId}:${view.harness}:${ability}`
    if (!lacking.has(key)) {
      lacking.add(key)
      for (const other of sessions.values()) {
        if (other.deviceId === view.deviceId && other.harness === view.harness)
          applySessionOps(other, [{ op: 'session.can', can: canOf(other.deviceId, other.harness) }])
      }
    }
    throw new ChannelError('unsupported', '对面不支持这个操作')
  }

  const loadSession = (deviceId: string, sessionId: string): SessionView => {
    const key = `session:${deviceId}:${sessionId}`
    let view = sessions.get(key) ?? tree.agentView(deviceId, sessionId)
    if (!view) {
      const summary = findSummary(deviceId, sessionId)
      const harness = harnessOn(deviceId, summary.harness)
      view = sampleSession(summary, deviceId, clock.now(), lang, harness)
      view.can = canOf(deviceId, view.harness)
      sessions.set(key, view)
    }
    // 归档着的只能看；放回来之后（见 session.unarchive）才又能发消息
    if (isShelved(deviceId, sessionId)) {
      view.live = false
      view.note = phrase('session.archived')
    }
    return view
  }

  // 改内存里的会话，再把同样的增量发给订阅者；之后新来的订阅者拿到的快照已经包含这些改动
  const applySessionOps = (view: SessionView, given: SessionOp[]) => {
    // 和设备那边一样，添加条目时记上开始、结束的时刻（步骤组的时长用）
    const now = clock.now()
    const ops = given.map((op) => {
      const stamped = spanOp(view, op, now)
      reduceSession(view, stamped)
      return stamped
    })
    emit(`session:${view.deviceId}:${view.sessionId}`, ops)
  }

  const sessionKey = (view: SessionView) => `session:${view.deviceId}:${view.sessionId}`
  const running = (view: SessionView) => view.turns.findLast((turn) => turn.status === 'running')

  /** 一个回合收尾：定稿回答，更新侧栏，再把排着队的下一条发出去 */
  const endTurn = (
    view: SessionView,
    turnId: string,
    itemId: string | null,
    status: 'completed' | 'interrupted' | 'failed',
    error: string | null = null,
  ) => {
    replies.delete(sessionKey(view))
    const turn = view.turns.find((entry) => entry.id === turnId)
    // 待办里还标着“正在做”的步骤（回合被打断了）改回“还没做”
    const todo = view.items[todoKey(turnId)]
    const settled = todo?.kind === 'todo' ? settleSteps(todo.steps) : null
    // “跑一会儿”的那条命令、“工具大结果”的工具、“忙一阵”的那几步还没跑完回合就停了（被打断）：也算没成，不留着一直转
    const busy = (turn?.itemIds ?? []).filter((id) => id.startsWith(`${turnId}-b`))
    const ran = [runKey(turnId), toolKey(turnId), ...busy].flatMap((id) => {
      const entry = view.items[id]
      return (entry?.kind === 'command' || entry?.kind === 'toolCall') &&
        entry.status === 'inProgress'
        ? [{ op: 'item.status', itemId: entry.id, status: 'failed' } satisfies SessionOp]
        : []
    })
    applySessionOps(view, [
      ...ran,
      ...(todo?.kind === 'todo' && settled !== todo.steps && settled
        ? [{ op: 'item.add', turnId, item: { ...todo, steps: settled } } satisfies SessionOp]
        : []),
      ...(itemId ? [{ op: 'item.status', itemId, status: 'completed' } satisfies SessionOp] : []),
      {
        op: 'turn.status',
        turnId,
        status,
        durationMs: clock.now() - (turn?.startedAt ?? clock.now()),
        ...(error ? { error } : {}),
      },
    ])
    // 没人开着它：和真的一样标成未读
    const watched = (sinks.get(sessionKey(view))?.size ?? 0) > 0
    updateSummary(view.deviceId, view.sessionId, {
      status: 'idle',
      waitingFor: null,
      updatedAt: clock.now(),
      ...(watched ? {} : { unread: true }),
    })
    diffs.turnEnded(view.deviceId, view.sessionId)
    tree.turnStopped(view)
    goal.turnEnded(view, turnId, status)
    const next = view.queued[0]
    if (next) {
      applySessionOps(view, [{ op: 'queue.set', queued: view.queued.slice(1) }])
      startTurn(view, next)
      return
    }
    // 会话树：子会话的回报、唤醒父会话；子代理回来了父会话接着说
    tree.ended(view, status)
  }

  /** 在一个进行中的回合里流出一段回答。tail：回答流完、回合结束之前再加的条目（会话树演示里的收尾调用） */
  const reply = (view: SessionView, turnId: string, text: string, tail?: () => SessionOp[]) => {
    const itemId = `${turnId}-a${++seq}`
    applySessionOps(view, [
      {
        op: 'item.add',
        turnId,
        item: { id: itemId, kind: 'agentMessage', text: '', phase: 'final', status: 'inProgress' },
      },
    ])
    const chunks = chunkText(text, lang === 'en' ? 2 : 1)
    const step = () => {
      const chunk = chunkMs <= 0 ? chunks.splice(0).join('') : chunks.shift()
      if (chunk)
        applySessionOps(view, [{ op: 'item.appendText', itemId, field: 'text', text: chunk }])
      if (chunks.length === 0) {
        if (tail) applySessionOps(view, tail())
        endTurn(view, turnId, itemId, 'completed')
        return
      }
      replies.set(sessionKey(view), clock.setTimer(step, chunkMs))
    }
    replies.set(sessionKey(view), clock.setTimer(step, Math.max(chunkMs, 1)))
    replyItems.set(sessionKey(view), { turnId, itemId })
  }

  /** 和真的一样：这个 harness 收指向文件的 mention，提到的文件才显示成附件；不收的写进正文 */
  const mentionsIn = (view: SessionView): boolean =>
    harnessOn(view.deviceId, view.harness)?.abilities?.mentions === true

  /**
   * 开一个回合，返回它的标识。event：注入在这条消息开头的那一段（会话树的回报、唤醒）；
   * 不给的话，用户发的消息带上攒着的回报
   */
  const startTurn = (
    view: SessionView,
    message: OutgoingMessage,
    event: SessionEventView | undefined = tree.notesFor(view),
  ): string => {
    const turnId = `m${++seq}`
    const userId = `${turnId}-u`
    const user = localUserMessage(userId, message, mentionsIn(view))
    applySessionOps(view, [
      {
        op: 'turn.add',
        turn: {
          id: turnId,
          status: 'running',
          itemIds: [userId],
          startedAt: clock.now(),
          durationMs: null,
          error: null,
        },
      },
      { op: 'item.add', turnId, item: event ? { ...user, event } : user },
    ])
    updateSummary(view.deviceId, view.sessionId, { status: 'running', updatedAt: clock.now() })
    if (tree.claim(view, turnId, message)) return turnId
    if (background.claim(view, turnId, message)) return turnId
    if (peerDemo.claim(view, turnId, message)) return turnId
    // 这三样只是顺带演一出别处的动静，回合照常往下走
    if (EDITS_ELSEWHERE.test(message.text)) manage.editElsewhere(view.deviceId, view.harness)
    if (RACES_SETTINGS.test(message.text)) manage.raceNextWrite(view.deviceId, view.harness)
    if (ADDS_SETTING.test(message.text)) manage.addSetting(view.deviceId, view.harness)
    if (EDITS_CONFIG_ELSEWHERE.test(message.text)) harnessConfig.editElsewhere(view.deviceId)
    if (RACES_CONFIG.test(message.text)) harnessConfig.raceNextWrite(view.deviceId)
    if (EDITS_MODELS_ELSEWHERE.test(message.text)) harnessConfig.modelsElsewhere(view.deviceId)
    if (LOCKS_MODELS.test(message.text)) harnessConfig.lockModels(view.deviceId)
    if (ORGANIZES_ELSEWHERE.test(message.text)) organize.elsewhere(view.deviceId, view.sessionId)
    // 本机的设备服务换没换版本的几出（关键字在 mock-service.mts 开头）
    service.stage(view.deviceId, message.text)
    // 远程设备服务比应用旧、一键升级的几出（关键字在 mock-remote-upgrade.mts 开头）
    remoteUpgrade.stage(view.deviceId, message.text)
    if (DROPS_HARNESS.test(message.text) && dropHarness(view, turnId)) return turnId
    if (ASKS_APPROVAL.test(message.text)) {
      askApproval(view, turnId)
      return turnId
    }
    if (LISTS_TODOS.test(message.text)) {
      runTodos(view, turnId)
      return turnId
    }
    if (ASKS_ONE.test(message.text)) {
      askQuestions(view, turnId, sampleQuestions([SAMPLE_TEXT[lang].singleQuestion], false))
      return turnId
    }
    if (RUNS_A_WHILE.test(message.text)) {
      runAWhile(view, turnId)
      return turnId
    }
    if (THINKS_A_WHILE.test(message.text)) {
      thinkAWhile(view, turnId)
      return turnId
    }
    if (REASONS_A_WHILE.test(message.text)) {
      reasonAWhile(view, turnId)
      return turnId
    }
    if (KEEPS_BUSY.test(message.text)) {
      keepBusy(view, turnId)
      return turnId
    }
    if (ASKS_WHILE_WORKING.test(message.text)) {
      const asks = SAMPLE_TEXT[lang].asyncAsks
      const item: ThreadItem = {
        type: 'agentMessage',
        id: `${turnId}-ask`,
        // 正文和真的 codex 一样：题目，下面每个选项一行
        text: asks
          .map((ask) =>
            [ask.title, ...(ask.options ?? []).map((option) => `- ${option}`)].join('\n'),
          )
          .join('\n\n'),
        phase: 'final_answer',
        memoryCitation: null,
        delivery: 'async',
        questions: asks,
      }
      applySessionOps(view, [{ op: 'item.add', turnId, item: projectItem(item) }])
      runAWhile(view, turnId, ASK_RUN_MS)
      return turnId
    }
    if (FLOODS.test(message.text) || BURSTS.test(message.text)) {
      flood(view, turnId, BURSTS.test(message.text) ? BURST_PER_TICK : FLOOD_PER_TICK)
      return turnId
    }
    if (HUGE_TOOLS.test(message.text)) {
      hugeTools(view, turnId)
      return turnId
    }
    const configLine = RUNS_CONFIG.exec(message.text)?.[1]
    if (configLine !== undefined && view.deviceId === 'local') {
      runConfig(view, turnId, configLine)
      return turnId
    }
    machine.stage(view.deviceId, message.text)
    const machineDemo = MACHINE_ASKS.find(([pattern]) => pattern.test(message.text))?.[1]
    if (machineDemo) {
      askMachine(view, turnId, machineDemo)
      return turnId
    }
    if (SIGNS_IN.test(message.text)) {
      askClientTool(view, turnId, signInDemo(message.text))
      return turnId
    }
    if (BROWSES.test(message.text) || USES_APP.test(message.text)) {
      askClientTool(view, turnId, BROWSES.test(message.text) ? 'site' : 'app')
      return turnId
    }
    if (ASKS_QUESTIONS.test(message.text)) {
      askQuestions(view, turnId, sampleQuestions(SAMPLE_TEXT[lang].questions, true))
      return turnId
    }
    if (view.settings.mode === 'plan') {
      planTurn(view, turnId)
      return turnId
    }
    // 选中回答加的评论：逐条回应，用 [N] 标出是哪一条
    const comments = message.extras.filter((extra) => extra.kind === 'comment')
    if (comments.length > 0) {
      reply(view, turnId, commentsReply(lang, comments))
      return turnId
    }
    // 话里带“评论”：回一段能选字的（过程里一段说明、一条命令，最终回答里有段落、代码块和表格）
    if (ASKS_COMMENTABLE.test(message.text)) {
      const sample = commentSample(lang)
      applySessionOps(view, [
        {
          op: 'item.add',
          turnId,
          item: {
            id: `${turnId}-n${++seq}`,
            kind: 'agentMessage',
            phase: 'commentary',
            status: 'completed',
            text: sample.note,
          },
        },
        {
          op: 'item.add',
          turnId,
          item: {
            id: `${turnId}-c${++seq}`,
            kind: 'command',
            command: sample.command,
            cwd: view.cwd,
            output: sample.output,
            elided: null,
            exitCode: 0,
            durationMs: 40,
            startedAt: clock.now(),
            status: 'completed',
          },
        },
      ])
      reply(view, turnId, sample.answer)
      return turnId
    }
    // 话里带“长报告”：过程里一段思考、一段说明、五条命令、一次读文件，最终回答很长（标题、两张表、列表）
    if (ASKS_REPORT.test(message.text)) {
      const sample = reportSample(lang)
      applySessionOps(view, [
        {
          op: 'item.add',
          turnId,
          item: {
            id: `${turnId}-t${++seq}`,
            kind: 'reasoning',
            status: 'completed',
            text: sample.thought,
          },
        },
        {
          op: 'item.add',
          turnId,
          item: {
            id: `${turnId}-n${++seq}`,
            kind: 'agentMessage',
            phase: 'commentary',
            status: 'completed',
            text: sample.note,
          },
        },
        ...sample.commands.map(
          ({ command, output }): SessionOp => ({
            op: 'item.add',
            turnId,
            item: {
              id: `${turnId}-c${++seq}`,
              kind: 'command',
              command,
              cwd: view.cwd,
              output,
              elided: null,
              exitCode: 0,
              durationMs: 80,
              startedAt: clock.now(),
              status: 'completed',
            },
          }),
        ),
        { op: 'item.add', turnId, item: projectItem(readCall(`${turnId}-r${++seq}`, sample.read)) },
      ])
      reply(view, turnId, sample.answer)
      return turnId
    }
    if (SHOWS_FILES.test(message.text)) {
      reply(view, turnId, SAMPLE_TEXT[lang].filesReply)
      return turnId
    }
    if (DRAWS.test(message.text)) {
      reply(view, turnId, SAMPLE_TEXT[lang].diagramReply)
      return turnId
    }
    if (EDITS_FILES.test(message.text)) {
      applySessionOps(view, [
        {
          op: 'item.add',
          turnId,
          item: {
            id: `${turnId}-f`,
            kind: 'fileChange',
            status: 'completed',
            changes: diffs.agentEdit(
              view.deviceId,
              view.cwd,
              view.sessionId,
              turnId,
              EDITS_BIG.test(message.text),
            ),
          },
        },
      ])
      reply(view, turnId, SAMPLE_TEXT[lang].editReply)
      return turnId
    }
    replyHeard(view, turnId)
    return turnId
  }

  /** 问着“要不要执行计划”的那些请求 */
  const planAsks = new Set<string>()

  /**
   * 计划模式下的回合：出一份计划。Claude Code 和 Pi 自己接着问要不要执行；Codex 说一句就结束，
   * 等界面来问（界面答“执行”走的是 session.implementPlan）
   */
  const planTurn = (view: SessionView, turnId: string) => {
    const sample = samplePlan(lang)
    applySessionOps(view, [
      { op: 'item.add', turnId, item: { id: `${turnId}-p`, kind: 'plan', text: sample.plan } },
    ])
    if (view.harness === 'claude' || view.harness === 'pi') {
      askQuestions(view, turnId, [view.harness === 'pi' ? PI_PLAN_QUESTION : sample.question])
      planAsks.add(`${turnId}-r`)
      return
    }
    reply(view, turnId, sample.done)
  }

  /** 各会话里刚收到的回答，一题一行。回合接着回话时带在前面，看得到对面收到了什么 */
  const heard = new Map<string, string>()

  /** 回合照常回话。之前答过提问的，先把收到的回答说一遍 */
  const replyHeard = (view: SessionView, turnId: string) => {
    const sample = SAMPLE_TEXT[lang]
    const lines = heard.get(sessionKey(view))
    heard.delete(sessionKey(view))
    reply(
      view,
      turnId,
      lines ? `${sample.answersHeard}\n\n${lines}\n\n${sample.mockReply}` : sample.mockReply,
    )
  }

  /** 回合里跑一条不出输出的命令，过一会儿结束（这时输出一次给全），再照常回话 */
  const runAWhile = (view: SessionView, turnId: string, ms = RUN_MS) => {
    const startedAt = clock.now()
    const item = {
      id: runKey(turnId),
      kind: 'command',
      command: 'npm test',
      cwd: view.cwd,
      output: '',
      elided: null,
      exitCode: null,
      durationMs: null,
      startedAt,
      status: 'inProgress',
    } satisfies ItemView
    applySessionOps(view, [{ op: 'item.add', turnId, item }])
    const finish = () => {
      applySessionOps(view, [
        {
          op: 'item.add',
          turnId,
          item: {
            ...item,
            output: SAMPLE_TEXT[lang].runOutput,
            exitCode: 0,
            durationMs: clock.now() - startedAt,
            status: 'completed',
          },
        },
      ])
      replyHeard(view, turnId)
    }
    replies.set(sessionKey(view), clock.setTimer(finish, ms))
  }

  /** 回合里两段空档：开头什么都不出，出一段说明后再停一会儿，再照常回话（见 THINKS_A_WHILE） */
  const thinkAWhile = (view: SessionView, turnId: string) => {
    const note = () => {
      applySessionOps(view, [
        {
          op: 'item.add',
          turnId,
          item: {
            id: `${turnId}-n${++seq}`,
            kind: 'agentMessage',
            phase: 'commentary',
            status: 'completed',
            text: commentSample(lang).note,
          },
        },
      ])
      replies.set(
        sessionKey(view),
        clock.setTimer(() => replyHeard(view, turnId), RUN_MS),
      )
    }
    replies.set(sessionKey(view), clock.setTimer(note, RUN_MS))
  }

  /** 回合开头空等一会儿，再出一条慢慢写的思考，写完照常回话（见 REASONS_A_WHILE） */
  const reasonAWhile = (view: SessionView, turnId: string) => {
    const itemId = `${turnId}-r${++seq}`
    const { secondThought, thoughtMore } = SAMPLE_TEXT[lang]
    const chunks = chunkText(`${secondThought}\n${thoughtMore}`, lang === 'en' ? 2 : 1)
    const every = Math.max(1, Math.floor(REASON_MS / Math.max(1, chunks.length)))
    const step = () => {
      const chunk = chunks.shift()
      if (chunk)
        applySessionOps(view, [{ op: 'item.appendText', itemId, field: 'text', text: chunk }])
      if (chunks.length > 0) {
        replies.set(sessionKey(view), clock.setTimer(step, every))
        return
      }
      applySessionOps(view, [{ op: 'item.status', itemId, status: 'completed' }])
      replyHeard(view, turnId)
    }
    const start = () => {
      applySessionOps(view, [
        {
          op: 'item.add',
          turnId,
          item: { id: itemId, kind: 'reasoning', status: 'inProgress', text: '' },
        },
      ])
      replies.set(sessionKey(view), clock.setTimer(step, every))
    }
    replies.set(sessionKey(view), clock.setTimer(start, RUN_MS))
  }

  /** 回合里按真的时间来一串过程，步与步之间停一会儿，最后照常回话（见 KEEPS_BUSY） */
  const keepBusy = (view: SessionView, turnId: string) => {
    const later = (step: () => void, ms: number) =>
      replies.set(sessionKey(view), clock.setTimer(step, ms))
    let n = 0
    /** 一条很快跑完的命令 */
    const command = (line: string) => (next: () => void) => {
      const startedAt = clock.now()
      const item = {
        id: busyKey(turnId, ++n),
        kind: 'command',
        command: line,
        cwd: view.cwd,
        output: '',
        elided: null,
        exitCode: null,
        durationMs: null,
        startedAt,
        status: 'inProgress',
      } satisfies ItemView
      applySessionOps(view, [{ op: 'item.add', turnId, item }])
      later(() => {
        const durationMs = clock.now() - startedAt
        const done = {
          ...item,
          output: 'ok\n',
          exitCode: 0,
          durationMs,
          status: 'completed' as const,
        }
        applySessionOps(view, [{ op: 'item.add', turnId, item: done }])
        next()
      }, BUSY_STEP_MS)
    }
    /** 读一个文件（Claude Code 的读投影出来是“Read 路径”） */
    const read = (path: string) => (next: () => void) => {
      const item = {
        id: busyKey(turnId, ++n),
        kind: 'toolCall',
        source: null,
        tool: `Read ${path}`,
        input: [],
        output: [],
        error: null,
        durationMs: null,
        status: 'inProgress',
      } satisfies ItemView
      applySessionOps(view, [{ op: 'item.add', turnId, item }])
      later(() => {
        const done = { ...item, durationMs: BUSY_STEP_MS, status: 'completed' as const }
        applySessionOps(view, [{ op: 'item.add', turnId, item: done }])
        next()
      }, BUSY_STEP_MS)
    }
    /** 一段一点点出字的思考或说明 */
    const stream = (kind: 'reasoning' | 'commentary', text: string) => (next: () => void) => {
      const itemId = `${turnId}-${kind === 'reasoning' ? 'r' : 'n'}${++seq}`
      applySessionOps(view, [
        {
          op: 'item.add',
          turnId,
          item:
            kind === 'reasoning'
              ? { id: itemId, kind: 'reasoning', status: 'inProgress', text: '' }
              : {
                  id: itemId,
                  kind: 'agentMessage',
                  phase: 'commentary',
                  status: 'inProgress',
                  text: '',
                },
        },
      ])
      const chunks = chunkText(text, lang === 'en' ? 2 : 1)
      const step = () => {
        const chunk = chunks.shift()
        if (chunk)
          applySessionOps(view, [{ op: 'item.appendText', itemId, field: 'text', text: chunk }])
        if (chunks.length > 0) {
          later(step, Math.max(chunkMs, 1))
          return
        }
        applySessionOps(view, [{ op: 'item.status', itemId, status: 'completed' }])
        next()
      }
      later(step, Math.max(chunkMs, 1))
    }
    const steps = [
      command('git log --oneline | head -40'),
      read('docs/HANDOFF.md'),
      stream('reasoning', SAMPLE_TEXT[lang].secondThought),
      command('wc -l docs/API_COVERAGE.md'),
      stream('commentary', commentSample(lang).note),
      command('ls -la .local'),
    ]
    const run = (index: number) => {
      const step = steps[index]
      later(step ? () => step(() => run(index + 1)) : () => replyHeard(view, turnId), BUSY_GAP_MS)
    }
    run(0)
  }

  /**
   * 回合里跑一次 litch config（见 RUNS_CONFIG）：和本机 harness 里的模型跑命令行一样交给执行器，
   * 放宽安全的那几项照样等确认卡。结果写进命令的输出，再照常回话
   */
  const runConfig = (view: SessionView, turnId: string, line: string) => {
    const startedAt = clock.now()
    const item = {
      id: runKey(turnId),
      kind: 'command',
      command: `litch config ${line}`.trim(),
      cwd: view.cwd,
      output: '',
      elided: null,
      exitCode: null,
      durationMs: null,
      startedAt,
      status: 'inProgress',
    } satisfies ItemView
    applySessionOps(view, [{ op: 'item.add', turnId, item }])
    void config.run(line, { threadId: view.sessionId, harness: view.harness }).then((result) => {
      applySessionOps(view, [
        {
          op: 'item.add',
          turnId,
          item: {
            ...item,
            output: result.text,
            exitCode: result.ok ? 0 : 1,
            durationMs: clock.now() - startedAt,
            status: result.ok ? 'completed' : 'failed',
          },
        },
      ])
      reply(view, turnId, SAMPLE_TEXT[lang][result.ok ? 'configDone' : 'configFailed'])
    })
  }

  /**
   * 回合里跑一条狂打日志的命令（见 FLOODS）。输出一段一段地追加，和真的核心收到的增量一样；
   * 打完了条目定稿（输出不再整份重给：留着的就是追加出来的那一份），再照常回话
   */
  const flood = (view: SessionView, turnId: string, perTick: number) => {
    const startedAt = clock.now()
    const itemId = runKey(turnId)
    applySessionOps(view, [
      {
        op: 'item.add',
        turnId,
        item: {
          id: itemId,
          kind: 'command',
          command: FLOOD_COMMAND,
          cwd: view.cwd,
          output: '',
          elided: null,
          exitCode: null,
          durationMs: null,
          startedAt,
          status: 'inProgress',
        },
      },
    ])
    let sent = 0
    let line = 0
    const step = () => {
      const ops: SessionOp[] = []
      for (let index = 0; index < perTick && sent < FLOOD_BYTES; index++) {
        let text = ''
        while (text.length < FLOOD_CHUNK) text += floodLine(++line)
        sent += text.length
        ops.push({ op: 'item.appendText', itemId, field: 'output', text })
      }
      applySessionOps(view, ops)
      if (sent < FLOOD_BYTES) {
        replies.set(sessionKey(view), clock.setTimer(step, FLOOD_TICK_MS))
        return
      }
      // 定稿：和真的核心收到“条目完成”一样整条换一遍，带上退出码和用时
      const current = view.items[itemId]
      if (current?.kind === 'command') {
        const item = { ...current, exitCode: 0, durationMs: clock.now() - startedAt }
        applySessionOps(view, [
          { op: 'item.add', turnId, item: { ...item, status: 'completed' } satisfies ItemView },
        ])
      }
      replyHeard(view, turnId)
    }
    replies.set(sessionKey(view), clock.setTimer(step, FLOOD_TICK_MS))
  }

  /**
   * 回合里先后调两次结果很大的工具（见 HUGE_TOOLS）。条目是协议里的样子经真的投影来的，和真的核心收到“条目开始”“条目完成”一样
   */
  const hugeTools = (view: SessionView, turnId: string) => {
    const put = (item: ThreadItem) =>
      applySessionOps(view, [{ op: 'item.add', turnId, item: projectItem(item) }])
    put(dumpCall(runKey(turnId), 'inProgress'))
    const steps = [
      () => {
        put(dumpCall(runKey(turnId), 'completed'))
        put(shotsCall(toolKey(turnId), 'inProgress'))
      },
      () => {
        put(shotsCall(toolKey(turnId), 'completed'))
        replyHeard(view, turnId)
      },
    ]
    const next = () => {
      steps.shift()?.()
      if (steps.length > 0) replies.set(sessionKey(view), clock.setTimer(next, TOOL_MS))
    }
    replies.set(sessionKey(view), clock.setTimer(next, TOOL_MS))
  }

  /** 客户端工具那两出：卡片的标识 → 演的是哪一出、条目是哪个 */
  const clientAsks = new Map<string, { demo: ClientToolDemo; itemId: string }>()

  /** 回合里调一次客户端工具，停下来等用户点头（见 BROWSES、USES_APP） */
  const askClientTool = (view: SessionView, turnId: string, demo: ClientToolDemo) => {
    const device = app.devices.find((entry) => entry.id === view.deviceId)
    if (!device) return
    const itemId = toolKey(turnId)
    const requestId = `${turnId}-r`
    clientAsks.set(requestId, { demo, itemId })
    applySessionOps(view, [
      { op: 'item.add', turnId, item: projectItem(clientToolCall(demo, itemId, null)) },
      { op: 'request.add', request: clientAskRequest(demo, requestId, itemId, device) },
    ])
    updateSummary(view.deviceId, view.sessionId, { status: 'waiting', waitingFor: 'approval' })
  }

  /** 远程设备操作这台电脑那几出：卡片的标识 → 演的是哪一出、条目是哪个 */
  const machineAsks = new Map<string, { demo: MachineDemo; itemId: string }>()
  /** “本会话都允许”记下的：会话 → 允许过（三出都是执行类的，只记这一类） */
  const machineGranted = new Set<string>()

  /** 那一次调用做完了：执行类的起一个进程、记一笔，条目带着结果完成，照常回话 */
  const machineDone = (view: SessionView, turnId: string, demo: MachineDemo, itemId: string) => {
    const device = app.devices.find((entry) => entry.id === view.deviceId)
    const ask = machineDemoAsk(demo)
    const processId =
      demo === 'exec' && device
        ? machine.start({
            deviceId: device.id,
            deviceName: device.name,
            sessionId: view.sessionId,
            harness: view.harness,
            command: ask.command ?? '',
            cwd: ask.cwd ?? '~',
          })
        : undefined
    machine.record({
      deviceId: view.deviceId,
      sessionId: view.sessionId,
      harness: view.harness,
      tool: demo === 'copy' ? 'copy' : 'exec',
      summary: machineSummary(ask),
      result: 'ok',
      flagged: ask.flagged.length > 0,
    })
    applySessionOps(view, [
      {
        op: 'item.add',
        turnId,
        item: projectItem(machineToolCall(demo, itemId, 'done', processId)),
      },
    ])
    replyHeard(view, turnId)
  }

  /** 回合里调一次 litch_machine（见 MACHINE_ASKS）：按开关和审批方式，当场失败、直接做，或者停下来问 */
  const askMachine = (view: SessionView, turnId: string, demo: MachineDemo) => {
    const device = app.devices.find((entry) => entry.id === view.deviceId)
    if (!device) return
    const access = device.machine
    const itemId = toolKey(turnId)
    const ask = machineDemoAsk(demo)
    if (!access?.enabled) {
      if (access) {
        machine.record({
          deviceId: device.id,
          sessionId: view.sessionId,
          harness: view.harness,
          tool: demo === 'copy' ? 'copy' : 'exec',
          summary: machineSummary(ask),
          result: 'disabled',
          flagged: false,
        })
      }
      applySessionOps(view, [
        { op: 'item.add', turnId, item: projectItem(machineToolCall(demo, itemId, 'disabled')) },
      ])
      replyHeard(view, turnId)
      return
    }
    const granted =
      access.approval === 'session' &&
      machineGranted.has(sessionKey(view)) &&
      ask.flagged.length === 0
    if (access.approval === 'never' || granted) {
      machineDone(view, turnId, demo, itemId)
      return
    }
    const requestId = `${turnId}-r`
    machineAsks.set(requestId, { demo, itemId })
    applySessionOps(view, [
      { op: 'item.add', turnId, item: projectItem(machineToolCall(demo, itemId, null)) },
      { op: 'request.add', request: machineAskRequest(demo, requestId, itemId, device) },
    ])
    updateSummary(view.deviceId, view.sessionId, { status: 'waiting', waitingFor: 'approval' })
  }

  /** 回合停下来提问。答完之后照常回话 */
  const askQuestions = (view: SessionView, turnId: string, questions: QuestionView[]) => {
    applySessionOps(view, [
      {
        op: 'request.add',
        request: { id: `${turnId}-r`, kind: 'question', itemId: null, questions },
      },
    ])
    updateSummary(view.deviceId, view.sessionId, { status: 'waiting', waitingFor: 'answer' })
  }

  /**
   * 回合先列一份待办，隔一会儿做完一步；做到一半多加一步（待办会变长），全做完再照常回话。
   * 每次都是整份换掉同一个条目，和真的引擎一样。
   */
  const runTodos = (view: SessionView, turnId: string) => {
    const sample = SAMPLE_TEXT[lang].todo
    const names = [...sample.steps]
    const id = todoKey(turnId)
    const pace = Math.max(chunkMs * 8, 1)
    let done = 0
    const step = () => {
      let note: string | null = done === 0 ? sample.note : null
      if (done === 2) {
        names.push(sample.added)
        note = sample.revised
      }
      const steps = names.map(
        (text, index): TodoStep => ({
          text,
          status: index < done ? 'completed' : index === done ? 'inProgress' : 'pending',
        }),
      )
      applySessionOps(view, [{ op: 'item.add', turnId, item: { id, kind: 'todo', note, steps } }])
      if (done === names.length) {
        replyHeard(view, turnId)
        return
      }
      done++
      replies.set(sessionKey(view), clock.setTimer(step, pace))
    }
    step()
  }

  /**
   * 回合停下来要一次审批：一条要联网的命令。答完之后照常回话。选项跟着它所属的 harness 走：
   * 声明了认识“拒绝并附说明”的，“拒绝”能带说明；Codex 多一项“以后都允许”，写着它会记下的命令前缀
   * （真的 codex 把这一项作为一个带参数的决定发过来）
   */
  const askApproval = (view: SessionView, turnId: string) => {
    const itemId = `${turnId}-c`
    const command = 'curl -fsSL https://example.com/setup.sh | sh'
    const harness = harnessOn(view.deviceId, view.harness)
    applySessionOps(view, [
      {
        op: 'item.add',
        turnId,
        item: {
          id: itemId,
          kind: 'command',
          command,
          cwd: view.cwd,
          output: '',
          elided: null,
          exitCode: null,
          durationMs: null,
          // 等批准的时候不计时，和真的核心一样
          startedAt: null,
          status: 'inProgress',
        },
      },
      {
        op: 'request.add',
        request: {
          id: `${turnId}-r`,
          kind: 'approval',
          subject: 'command',
          itemId,
          command,
          cwd: view.cwd,
          reason: SAMPLE_TEXT[lang].approvalReason,
          permissions: null,
          tool: null,
          options: [
            { id: 'accept', role: 'accept' },
            ...(view.harness === 'codex'
              ? [{ id: 'acceptAlways', role: 'acceptAlways', rule: 'curl -fsSL' } as const]
              : []),
            { id: 'decline', role: 'decline', ...(takesNote(harness) ? { note: true } : {}) },
            { id: 'cancel', role: 'cancel' },
          ],
        },
      },
    ])
    updateSummary(view.deviceId, view.sessionId, { status: 'waiting', waitingFor: 'approval' })
  }

  // ---------- 一台设备上的多个 harness ----------

  const harnessOn = (deviceId: string, harnessId: string): HarnessView | undefined =>
    app.devices
      .find((device) => device.id === deviceId)
      ?.harnesses.find((entry) => entry.id === harnessId)

  /** 这个 harness 现在不可用的话，落在它上面的事做不了：和真的一样，说明是哪一个不可用 */
  const mustBeUp = (deviceId: string, harnessId: string) => {
    const harness = harnessOn(deviceId, harnessId)
    if (!harness || harness.state === 'ready') return
    throw new ChannelError(
      'remote',
      `${harness.name} 现在不可用`,
      phrase('fault.harnessUnavailable', { name: harness.name }),
    )
  }

  /** 改一个 harness 的状态。“哪些 harness 用不了、侧栏里留着的是它上次的会话”跟着变 */
  const setHarness = (deviceId: string, harnessId: string, patch: Partial<HarnessView>) => {
    const device = app.devices.find((entry) => entry.id === deviceId)
    if (!device) return
    const harnesses = device.harnesses.map((entry) =>
      entry.id === harnessId ? { ...entry, ...patch } : entry,
    )
    patchDevice(deviceId, { harnesses, stranded: strandedOf(deviceId, harnesses) })
  }

  // ---------- 终端 ----------
  const terminals = createMockTerminals({
    clock,
    stepMs: chunkMs,
    lang,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
    workspaceRoot: (deviceId, workspaceId) =>
      sidebars.get(deviceId)?.workspaces.find((entry) => entry.id === workspaceId)?.roots[0] ??
      null,
  })

  // ---------- 文件面板 ----------
  const files = createMockFiles({
    clock,
    stepMs: chunkMs,
    lang,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
    // 认得的根：工作区的根，和会话的工作目录
    knownRoot(deviceId, root) {
      const view = sidebars.get(deviceId)
      if (!view) return false
      return (
        view.workspaces.some((workspace) => workspace.roots.includes(root)) ||
        view.sessions.some((session) => session.cwd === root)
      )
    },
  })

  // ---------- 差异面板 ----------
  const diffs = createMockDiffs({
    clock,
    stepMs: chunkMs,
    lang,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
    knownRoot(deviceId, root) {
      const view = sidebars.get(deviceId)
      if (!view) return false
      return (
        view.workspaces.some((workspace) => workspace.roots.includes(root)) ||
        view.sessions.some((session) => session.cwd === root)
      )
    },
    turnDiffDeclared(deviceId, sessionId) {
      const session = sidebars.get(deviceId)?.sessions.find((entry) => entry.id === sessionId)
      return (session && harnessOn(deviceId, session.harness)?.abilities?.turnDiff) ?? null
    },
  })

  // ---------- 设备与 harness 管理 ----------

  /** 这个 harness 上的会话里，有回合在跑或者停着等人的那些 */
  const engaged = (deviceId: string, harnessId: string): SessionSummary[] =>
    (sidebars.get(deviceId)?.sessions ?? []).filter(
      (session) =>
        session.harness === harnessId &&
        (session.status === 'running' || session.status === 'waiting'),
    )

  const manage = createMockManagement({
    clock,
    stepMs: chunkMs,
    // 任务卡的开关改了：设备的开关一栏跟着变
    taskCardsChanged(deviceId) {
      const device = app.devices.find((entry) => entry.id === deviceId)
      if (device) emitDevice(device)
    },
    devices: () => app.devices,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
    setHarness: (deviceId, harnessId, patch) => {
      setHarness(deviceId, harnessId, patch)
      harnessConfig.harnessChanged(deviceId, harnessId)
    },
    busy: (deviceId, harnessId) => engaged(deviceId, harnessId).length > 0,
    // 强行重启：这个 harness 上在跑的回合都记成中断，等着的请求一并作废
    interrupt(deviceId, harnessId) {
      for (const summary of engaged(deviceId, harnessId)) {
        const view = sessions.get(`session:${deviceId}:${summary.id}`)
        const turn = view ? running(view) : undefined
        if (!view || !turn) {
          // 没打开过的会话只有侧栏上的那一行
          updateSummary(deviceId, summary.id, { status: 'idle', waitingFor: null })
          continue
        }
        replies.get(sessionKey(view))?.()
        if (sessionKey(view) === streamKey && streaming === 'running') {
          stopStream?.()
          stopStream = null
          streaming = 'done'
        }
        applySessionOps(
          view,
          view.requests.map((request) => ({ op: 'request.remove', requestId: request.id })),
        )
        const current = replyItems.get(sessionKey(view))
        endTurn(view, turn.id, current?.turnId === turn.id ? current.itemId : null, 'interrupted')
      }
    },
  })

  // ---------- 扫码绑定手机（mock-pairing.mts） ----------
  const pairing = createMockPairing({
    clock,
    stepMs: chunkMs,
    ...(options.pairTtlMs ? { ttlMs: options.pairTtlMs } : {}),
    lang,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
  })

  // ---------- 手机批准（mock-approvals.mts） ----------
  const approvals = createMockApprovals({
    clock,
    firstSession: (deviceId) => sidebars.get(deviceId)?.sessions[0]?.id ?? null,
    deviceName: (deviceId) => {
      const named = app.devices.find((entry) => entry.id === deviceId)?.name
      return typeof named === 'string' ? named : deviceId
    },
  })

  // ---------- 工作树（mock-worktrees.mts） ----------
  const worktrees = createMockWorktrees({
    clock,
    stepMs: chunkMs,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
    sessions: (deviceId) => sidebars.get(deviceId)?.sessions ?? [],
    roots: (deviceId) =>
      (sidebars.get(deviceId)?.workspaces ?? []).flatMap((workspace) => workspace.roots),
    owned(deviceId, sessionId, worktree) {
      const sidebar = sidebars.get(deviceId)
      const index = sidebar?.sessions.findIndex((entry) => entry.id === sessionId) ?? -1
      if (!sidebar || index < 0) return
      const next = { ...(sidebar.sessions[index] as SessionSummary), worktree }
      sidebar.sessions[index] = next
      emit(`sidebar:${deviceId}`, [{ op: 'session.upsert', session: next }])
    },
  })

  // ---------- 给设备装 harness（mock-install.mts） ----------
  const install = createMockInstall({
    clock,
    stepMs: chunkMs,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
    installed(deviceId, harness, version) {
      const device = app.devices.find((entry) => entry.id === deviceId)
      if (!device) return
      // 和真的一样：装好就重探，停用的顺手启用（决 302），然后它就是可用的
      const ready: HarnessView = { ...sampleHarness(harness), version }
      const had = device.harnesses.some((entry) => entry.id === harness)
      const harnesses = had
        ? device.harnesses.map((entry) => (entry.id === harness ? ready : entry))
        : [...device.harnesses, ready]
      patchDevice(deviceId, { harnesses, stranded: strandedOf(deviceId, harnesses) })
      manage.installed(deviceId, ready)
    },
  })

  // ---------- harness 详情设置（mock-harness-config.mts） ----------
  const harnessConfig = createMockHarnessConfig({
    clock,
    stepMs: chunkMs,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
    writeEnv: (deviceId, harness, name, value) => manage.writeEnv(deviceId, harness, name, value),
  })

  // ---------- litch config（mock-config.mts） ----------
  const config = createMockConfig({
    clock,
    version: options.version ?? '0.0.0',
    lang,
    core: () => core,
  })

  // ---------- 定时任务（mock-tasks.mts） ----------
  const tasks = createMockTasks({
    clock,
    stepMs: chunkMs,
    lang,
    devices: () => app.devices,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
    hasSession: (deviceId, sessionId) =>
      sidebars.get(deviceId)?.sessions.some((session) => session.id === sessionId) ?? false,
    mark: (deviceId, sessionId, mark) => updateSummary(deviceId, sessionId, { task: mark }),
    spawn(deviceId, init) {
      const sidebar = sidebars.get(deviceId)
      if (!sidebar) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
      const summary: SessionSummary = {
        id: `new${++seq}`,
        workspaceId: init.workspaceId,
        harness: init.harness,
        title: init.title,
        status: 'running',
        waitingFor: null,
        unread: false,
        updatedAt: clock.now(),
        cwd: init.cwd,
        pinned: false,
        section: null,
        placedAt: null,
        task: null,
        lineage: null,
        nativeLineage: null,
        background: null,
        worktree: null,
      }
      sidebar.sessions.push(summary)
      emit(`sidebar:${deviceId}`, [{ op: 'session.upsert', session: summary }])
      const view: SessionView = {
        deviceId,
        sessionId: summary.id,
        title: summary.title,
        harness: summary.harness,
        cwd: summary.cwd,
        live: true,
        note: null,
        turns: [],
        items: {},
        requests: [],
        queued: [],
        settings: sampleSettings(harnessOn(deviceId, init.harness)),
        usage: null,
        can: canOf(deviceId, summary.harness),
        forkedFrom: null,
        proposals: [],
        agents: [],
      }
      sessions.set(sessionKey(view), view)
      return summary.id
    },
    say(deviceId, sessionId, prompt, answer) {
      const view = loadSession(deviceId, sessionId)
      const turnId = `m${++seq}`
      const userId = `${turnId}-u`
      const itemIds = answer === null ? [userId] : [userId, `${turnId}-a`]
      applySessionOps(view, [
        {
          op: 'turn.add',
          turn: {
            id: turnId,
            status: 'running',
            itemIds: [],
            startedAt: clock.now(),
            durationMs: null,
            error: null,
          },
        },
        {
          op: 'item.add',
          turnId,
          item: localUserMessage(userId, outgoing(prompt), mentionsIn(view)),
        },
        ...(answer === null
          ? []
          : [
              {
                op: 'item.add',
                turnId,
                item: {
                  id: itemIds[1] ?? '',
                  kind: 'agentMessage',
                  text: answer,
                  phase: 'final',
                  status: 'completed',
                },
              } satisfies SessionOp,
            ]),
        {
          op: 'turn.status',
          turnId,
          status: answer === null ? 'failed' : 'completed',
          durationMs: 3000,
          ...(answer === null ? { error: sampleTaskAnswer(lang).failed } : {}),
        },
      ])
      // 没人开着它：和真的一样标成未读
      const watched = (sinks.get(sessionKey(view))?.size ?? 0) > 0
      updateSummary(deviceId, sessionId, {
        status: 'idle',
        waitingFor: null,
        updatedAt: clock.now(),
        ...(watched ? {} : { unread: true }),
      })
    },
  })
  // 一开始就跟定时任务有关的示例会话：侧栏那几行带着记号
  for (const [deviceId, view] of sidebars) {
    const marks = tasks.marks(deviceId)
    if (marks.size === 0) continue
    view.sessions = view.sessions.map((session) => {
      const mark = marks.get(session.id)
      return mark ? { ...session, task: mark } : session
    })
  }

  // ---------- 设备服务是哪一份、换没换版本 ----------
  // ---------- 远程设备操作这台电脑（08 号） ----------
  const machine = createMockMachine({
    clock,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
    patch: (deviceId, patch) => void patchDevice(deviceId, patch),
  })

  const service = createMockService({
    clock,
    stepMs: chunkMs,
    lang,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
    patch: (deviceId, patch) => void patchDevice(deviceId, patch),
    engaged: (deviceId) => [
      ...new Set(
        (sidebars.get(deviceId)?.sessions ?? [])
          .filter((session) => session.status === 'running' || session.status === 'waiting')
          .map((session) => session.harness),
      ),
    ],
  })

  const remoteUpgrade = createMockRemoteUpgrade({
    clock,
    stepMs: chunkMs,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
    patch: (deviceId, patch) => void patchDevice(deviceId, patch),
    engaged: (deviceId) => [
      ...new Set(
        (sidebars.get(deviceId)?.sessions ?? [])
          .filter((session) => session.status === 'running' || session.status === 'waiting')
          .map((session) => session.harness),
      ),
    ],
  })

  const compose = createMockCompose({
    clock,
    // 晚三拍到：够看见“正在取”，又不至于让人等
    delayMs: chunkMs * 3,
    lang,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
    manual: options.scene === 'fresh',
  })

  const organize = createMockOrganize({
    clock,
    stepMs: chunkMs,
    device: (deviceId) => app.devices.find((entry) => entry.id === deviceId),
    sidebar: (deviceId) => sidebars.get(deviceId),
    replaced(deviceId) {
      const view = sidebars.get(deviceId)
      if (view) for (const sink of sinks.get(`sidebar:${deviceId}`) ?? []) sink.snapshot(view)
    },
    emit: (deviceId, ops) => emit(`sidebar:${deviceId}`, ops),
    elsewhereName: SAMPLE_TEXT[lang].elsewhereWorkspace,
  })

  // 会话树：Litch 子会话、提案、回报与唤醒，引擎自己的子代理线程（mock-tree.mts）
  const tree = createMockTree({
    lang,
    now: () => clock.now(),
    setTimer: (run, ms) => clock.setTimer(run, ms),
    summary: (deviceId, sessionId) =>
      sidebars.get(deviceId)?.sessions.find((session) => session.id === sessionId),
    summaries: (deviceId) => sidebars.get(deviceId)?.sessions ?? [],
    addSummary(deviceId, summary) {
      sidebars.get(deviceId)?.sessions.push(summary)
      emit(`sidebar:${deviceId}`, [{ op: 'session.upsert', session: summary }])
    },
    updateSummary,
    view: loadSession,
    putView: (view) => sessions.set(sessionKey(view), view),
    apply: applySessionOps,
    startTurn: (view, message, event) => startTurn(view, message, event),
    reply,
    finish(view, turnId, ops) {
      applySessionOps(view, ops)
      endTurn(view, turnId, null, 'completed')
    },
    fail: (view, turnId, error) => endTurn(view, turnId, null, 'failed', error),
    stop(view, turnId) {
      if (running(view)?.id === turnId) endTurn(view, turnId, null, 'interrupted')
    },
    running: (view) => running(view) !== undefined,
    enqueue: (view, message) =>
      applySessionOps(view, [
        { op: 'queue.set', queued: [...view.queued, { id: `q${++seq}`, ...message }] },
      ]),
    treeOn: (deviceId) =>
      app.devices.find((device) => device.id === deviceId)?.sessionTree === true,
    harnesses: (deviceId) => app.devices.find((device) => device.id === deviceId)?.harnesses ?? [],
    settings: (deviceId, harness) => sampleSettings(harnessOn(deviceId, harness)),
    can: (deviceId, harness) => canOf(deviceId, harness),
    nextId: (prefix) => `${prefix}${++seq}`,
    childWorktree(deviceId, sessionId, cwd, from, title) {
      // 建不成（不在工作区里之类）就共用父会话的目录，和设备进程照缺省开的一样
      worktrees
        .create(deviceId, cwd, from, title)
        .then((made) => {
          worktrees.own(deviceId, made.id, sessionId)
          const where = made.subPath ? `${made.path}/${made.subPath}` : made.path
          updateSummary(deviceId, sessionId, { cwd: where })
          const view = sessions.get(`session:${deviceId}:${sessionId}`)
          if (view) view.cwd = where
        })
        .catch(() => {})
    },
  })

  // 后台任务：回合结束后还在跑的两条命令，先结束的那条叫醒会话（mock-background.mts）
  const background = createMockBackground({
    lang,
    now: () => clock.now(),
    setTimer: (run, ms) => clock.setTimer(run, ms),
    summary: (deviceId, sessionId) =>
      sidebars.get(deviceId)?.sessions.find((session) => session.id === sessionId),
    updateSummary,
    apply: applySessionOps,
    reply,
    nextId: (prefix) => `${prefix}${++seq}`,
  })

  // 会话间消息：发出一条，过一会儿 Claude 桌面端的会话发来一条（mock-peer.mts）
  const peerDemo = createMockPeer({
    lang,
    now: () => clock.now(),
    setTimer: (run, ms) => clock.setTimer(run, ms),
    updateSummary,
    apply: applySessionOps,
    reply,
    nextId: (prefix) => `${prefix}${++seq}`,
  })

  // 持续目标：空闲时自己开续跑回合，第三轮报做完（mock-goal.mts）
  const goal = createMockGoal({
    lang,
    now: () => clock.now(),
    setTimer: (run, ms) => clock.setTimer(run, ms),
    apply: applySessionOps,
    reply,
    busy: (view) => running(view) !== undefined,
    started: (view) =>
      updateSummary(view.deviceId, view.sessionId, { status: 'running', updatedAt: clock.now() }),
    nextId: (prefix) => `${prefix}${++seq}`,
  })

  /** 掉线的那些回合：harness 回来的时候收尾 */
  const dropped = new Map<string, () => void>()

  /**
   * 这个会话所属的 harness 掉线，过一会儿自己回来。只有一个 harness 的设备上不演这一出，返回 false。
   * 掉线期间回合停在那里；回来之后这个回合记成中断（真的重新订阅之后看到的就是这样）。
   */
  const dropHarness = (view: SessionView, turnId: string): boolean => {
    const device = app.devices.find((entry) => entry.id === view.deviceId)
    if (device?.mode !== 'full' || !harnessOn(view.deviceId, view.harness)) return false
    const key = `${view.deviceId}:${view.harness}`
    dropped.get(key)?.()
    setHarness(view.deviceId, view.harness, {
      state: 'unavailable',
      reason: phrase('harness.disconnected'),
      detail: null,
      down: 'disconnected',
    })
    const back = () => {
      dropped.delete(key)
      setHarness(view.deviceId, view.harness, {
        state: 'ready',
        reason: null,
        detail: null,
        down: null,
      })
      if (running(view)?.id === turnId) endTurn(view, turnId, null, 'interrupted')
    }
    dropped.set(key, clock.setTimer(back, Math.max(chunkMs * 60, 1)))
    return true
  }

  const openView = (params: { deviceId: string; sessionId: string }): SessionView =>
    loadSession(params.deviceId, params.sessionId)

  /** 要往对面发东西的那几件事用：会话所属的 harness 不可用时做不了 */
  const reachView = (params: { deviceId: string; sessionId: string }): SessionView => {
    const view = openView(params)
    mustBeUp(view.deviceId, view.harness)
    return view
  }

  const finishStream = (view: SessionView, startedAt: number) => {
    streaming = 'done'
    applySessionOps(view, [
      { op: 'item.status', itemId: STREAM_SESSION.itemId, status: 'completed' },
      {
        op: 'turn.status',
        turnId: STREAM_SESSION.turnId,
        status: 'completed',
        durationMs: clock.now() - startedAt,
      },
    ])
    updateSummary(view.deviceId, view.sessionId, { status: 'idle', updatedAt: clock.now() })
  }

  // 第一次有人订阅那个“进行中”的会话时开始流
  const startStream = (view: SessionView) => {
    if (streaming !== 'idle') return
    streaming = 'running'
    const startedAt = view.turns.find((turn) => turn.id === STREAM_SESSION.turnId)?.startedAt ?? 0
    const chunks = chunkText(streamText(lang).rest, lang === 'en' ? 2 : 1)
    if (chunkMs <= 0) {
      const text = chunks.join('')
      applySessionOps(view, [
        { op: 'item.appendText', itemId: STREAM_SESSION.itemId, field: 'text', text },
      ])
      finishStream(view, startedAt)
      return
    }
    const step = () => {
      stopStream = null
      const text = chunks.shift()
      if (text === undefined) {
        finishStream(view, startedAt)
        return
      }
      applySessionOps(view, [
        { op: 'item.appendText', itemId: STREAM_SESSION.itemId, field: 'text', text },
      ])
      stopStream = clock.setTimer(step, chunkMs)
    }
    stopStream = clock.setTimer(step, chunkMs)
  }

  // ---------- 设备的增、改、删 ----------
  // 加进来的远程设备照着真的那样走一遍：先是“正在连”，过一会儿连上（只有 Codex、没有会话），
  // 或者停在一个要人处理的原因上。哪台主机是哪种结果看 SAMPLE_HOSTS。

  /** 各台设备改过的浏览器、Computer Use 开关（和真核心存的一样，remote.mts） */
  const savedTools = new Map<string, SavedToolSwitches>()
  /** 设备的开关一栏：设备一级的两个，和每个 harness 的三样（任务卡读模拟的设备设置） */
  const toolsOf = (device: DeviceView): DeviceView['tools'] => {
    const kept = savedTools.get(device.id)
    const now = toolSwitchesOf(kept, null)
    return {
      browser: device.tools.browser === null ? null : now.browser,
      computer: device.tools.computer === null ? null : now.computer,
      harnesses: Object.fromEntries(
        device.harnesses.map((harness) => [
          harness.id,
          {
            taskCards: manage.taskCards(device.id, harness.id),
            ...toolSwitchesOf(kept, harness.id),
          },
        ]),
      ),
    }
  }
  /** 发出去之前把开关一栏算一遍：harness 装了、连上了、任务卡改了，都在这里跟上 */
  const emitDevice = (device: DeviceView) => {
    const fresh = { ...device, tools: toolsOf(device) }
    const index = app.devices.findIndex((entry) => entry.id === device.id)
    if (index !== -1) app.devices[index] = fresh
    emit('app', [{ op: 'device.upsert', device: fresh }])
  }
  // 一开始的那几台：开关一栏先算好
  for (const [index, device] of app.devices.entries()) {
    app.devices[index] = { ...device, tools: toolsOf(device) }
  }

  const patchDevice = (deviceId: string, patch: Partial<DeviceView>): DeviceView => {
    const index = app.devices.findIndex((device) => device.id === deviceId)
    const before = app.devices[index]
    if (!before) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    const next = { ...before, ...patch }
    app.devices[index] = next
    emitDevice(next)
    return next
  }

  /** 示例里这台主机连过去是什么结果 */
  const outcomeOf = (target: RemoteTarget): RemoteCheck => {
    const name = target.kind === 'alias' ? target.alias : target.host
    const sample = SAMPLE_HOSTS.find((host) => host.alias === name)
    const fail = (failure: Omit<ConnectFailureView, 'retrying'>): RemoteCheck => ({
      ok: false,
      failure: { ...failure, retrying: false },
    })
    if (sample?.result === 'bare') {
      return fail({
        stage: 'notInstalled',
        text: phrase('remote.notInstalled'),
        detail: null,
        guide: 'install',
      })
    }
    if (sample?.result === 'untrusted') {
      return fail({
        stage: 'hostKey',
        text: phrase('ssh.hostKeyUnknown'),
        detail: 'Host key verification failed.',
      })
    }
    if (sample?.result === 'service' || sample?.result === 'idle') {
      // 装了设备服务的：正在跑的看得到上面有哪些 harness，没在跑的要连上之后才知道
      const running = sample.result === 'service'
      return {
        ok: true,
        peer: 'service',
        version: '0.6.0',
        system: 'Linux',
        running,
        harnesses: running ? [sampleHarness('claude'), sampleHarness('pi')] : null,
      }
    }
    return { ok: true, peer: 'codex', version: '0.160.0', system: 'Linux' }
  }

  /** 各台设备正在走的那次连接：取消函数 */
  const connecting = new Map<string, () => void>()

  const connectDevice = (deviceId: string, target: RemoteTarget) => {
    connecting.get(deviceId)?.()
    patchDevice(deviceId, {
      connection: 'connecting',
      note: phrase('ssh.step.connect'),
      failure: null,
      organizable: false,
    })
    const steps: (() => void)[] = [
      () => patchDevice(deviceId, { note: phrase('ssh.step.probe') }),
      () => {
        const result = outcomeOf(target)
        if (result.ok && result.peer === 'service') {
          // 设备服务：完整模式，上面是它声明的那几个 harness。示例里没有给它备设置，所以不能管理
          patchDevice(deviceId, {
            connection: 'online',
            note: null,
            mode: 'full',
            os: 'linux',
            harnesses: result.harnesses ?? [sampleHarness('claude'), sampleHarness('pi')],
            organizable: true,
            // 设备服务会报自己是哪一份
            service: sampleRemoteService(clock.now()),
          })
        } else if (result.ok) {
          patchDevice(deviceId, {
            connection: 'online',
            note: null,
            mode: 'single',
            os: 'linux',
            // 直接连的原生 codex：没有声明
            harnesses: [
              { ...sampleHarness('codex', { declared: false }), version: result.version },
            ],
            organizable: true,
          })
        } else {
          patchDevice(deviceId, {
            connection: 'error',
            note: result.failure.text,
            failure: result.failure,
          })
        }
      },
    ]
    const next = () => {
      const step = steps.shift()
      if (!step) {
        connecting.delete(deviceId)
        return
      }
      step()
      connecting.set(deviceId, clock.setTimer(next, 700))
    }
    connecting.set(deviceId, clock.setTimer(next, 700))
  }

  const remoteOf = (deviceId: string): DeviceView & { target: RemoteTarget } => {
    const device = app.devices.find((entry) => entry.id === deviceId)
    if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
    if (!device.target) throw new ChannelError('rejected', '本机设备不能这样改')
    return device as DeviceView & { target: RemoteTarget }
  }

  const deviceCommand = (name: string, params: unknown): unknown => {
    if (name === 'remote.discover') {
      return { hosts: SAMPLE_HOSTS.map(({ result: _result, ...host }) => host) }
    }
    if (name === 'remote.check') {
      return outcomeOf(checkTarget((params as Commands['remote.check']['params']).target))
    }
    if (name === 'device.add') {
      const { name: given, target, wire } = params as Commands['device.add']['params']
      const checked = checkTarget(target)
      if (app.devices.some((device) => device.target && sameTarget(device.target, checked))) {
        throw new ChannelError('rejected', '这台设备已经加过了')
      }
      const used = new Set(app.devices.map((device) => device.wire))
      const device: DeviceView = {
        id: `ssh-${++seq}`,
        name: given.trim() || defaultName(checked),
        host: hostLabel(checked),
        kind: 'ssh',
        target: checked,
        wire: wire ?? WIRES.find((entry) => !used.has(entry)) ?? 'slate',
        connection: 'connecting',
        mode: 'single',
        os: null,
        harnesses: [],
        stranded: [],
        note: null,
        failure: null,
        stale: false,
        organizable: false,
        manageable: false,
        service: null,
        upgrade: null,
        remoteUpgrade: null,
        tools: { browser: true, computer: false },
        // 新加的远程设备：“操作这台电脑”默认关
        machine: sampleMachineAccess(''),
        sessionTree: false,
        pairing: false,
        install: false,
        worktrees: false,
      }
      app.devices.push(device)
      sidebars.set(device.id, {
        deviceId: device.id,
        workspaces: [],
        sections: [],
        sessions: [],
        archived: null,
      })
      emitDevice(device)
      connectDevice(device.id, checked)
      return { deviceId: device.id }
    }
    if (name === 'device.update') {
      const { deviceId, name: given, wire, target } = params as Commands['device.update']['params']
      if (deviceId === 'local') {
        if (given !== undefined || target !== undefined) {
          throw new ChannelError('rejected', '本机设备只能改线色')
        }
        if (wire) patchDevice(deviceId, { wire })
        return {}
      }
      const before = remoteOf(deviceId)
      const checked = target === undefined ? before.target : checkTarget(target)
      patchDevice(deviceId, {
        ...(given === undefined ? {} : { name: given.trim() || defaultName(checked) }),
        ...(wire === undefined ? {} : { wire }),
        target: checked,
        host: hostLabel(checked),
      })
      if (!sameTarget(before.target, checked)) {
        // 换了一台机器：侧栏清空，重新连
        const empty: SidebarView = {
          deviceId,
          workspaces: [],
          sections: [],
          sessions: [],
          archived: null,
        }
        sidebars.set(deviceId, empty)
        for (const sink of sinks.get(`sidebar:${deviceId}`) ?? []) sink.snapshot(empty)
        patchDevice(deviceId, { stale: false, harnesses: [], organizable: false, service: null })
        connectDevice(deviceId, checked)
      }
      return {}
    }
    if (name === 'device.remove') {
      const { deviceId } = params as Commands['device.remove']['params']
      remoteOf(deviceId)
      connecting.get(deviceId)?.()
      connecting.delete(deviceId)
      app.devices.splice(
        app.devices.findIndex((device) => device.id === deviceId),
        1,
      )
      sidebars.delete(deviceId)
      emit('app', [{ op: 'device.remove', deviceId }])
      return {}
    }
    if (name === 'device.tools.set') {
      const {
        deviceId,
        harness,
        browser,
        computer,
        machine: operate,
      } = params as Commands['device.tools.set']['params']
      const device = app.devices.find((entry) => entry.id === deviceId)
      if (!device) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
      if (harness !== undefined && operate !== undefined) {
        throw new ChannelError('invalid', '“操作这台电脑”不分 harness，不要带 harness')
      }
      if (typeof operate === 'boolean') machine.toggle(deviceId, operate)
      savedTools.set(
        deviceId,
        changeToolSwitches(savedTools.get(deviceId), {
          ...(harness === undefined ? {} : { harness }),
          ...(typeof browser === 'boolean' ? { browser } : {}),
          ...(typeof computer === 'boolean' ? { computer } : {}),
        }),
      )
      emitDevice(device)
      return {}
    }
    if (name === 'device.upgradeService') {
      const { deviceId, mode } = params as Commands['device.upgradeService']['params']
      remoteUpgrade.run(deviceId, mode)
      return {}
    }
    if (name === 'device.reconnect') {
      const { deviceId } = params as Commands['device.reconnect']['params']
      // 因为忙没换版本的本机：这就是“现在再试一次”
      if (service.retry(deviceId)) return {}
      const device = app.devices.find((entry) => entry.id === deviceId)
      // 示例里本来就连着的那几台不用动；没连上的重新走一遍
      if (device?.target && device.connection !== 'online') {
        connectDevice(deviceId, device.target)
      }
      return {}
    }
    return undefined
  }

  const core: MockCore = {
    terminalsAlive: () => terminals.alive(),
    async endTerminals() {
      terminals.endAll()
    },

    async command(name, params, signal) {
      if (name === 'core.info') {
        return { version: options.version ?? '0.0.0', mock: true }
      }
      const handled = deviceCommand(name, params)
      if (handled !== undefined) return handled
      const operated = machine.command(name, params)
      if (operated !== undefined) return operated
      const organized = organize.command(name, params)
      if (organized !== undefined) return organized
      const managed = manage.command(name, params)
      if (managed !== undefined) {
        // 重启过的 harness：详情设置那边要重启才生效的用上
        if (name === 'device.harness.restart') {
          const { deviceId, harness } = params as { deviceId: string; harness: string }
          return managed.then((result) => {
            harnessConfig.restarted(deviceId, harness)
            return result
          })
        }
        return managed
      }
      const tuned = harnessConfig.command(name, params)
      if (tuned !== undefined) return tuned
      const scheduled = tasks.command(name, params)
      if (scheduled !== undefined) return scheduled
      const paired = pairing.command(name, params)
      if (paired !== undefined) return paired
      const approved = approvals.command(name, params)
      if (approved !== undefined) return approved
      const installing = install.command(name, params)
      if (installing !== undefined) return installing
      const branched = worktrees.command(name, params)
      if (branched !== undefined) return branched
      const configured = config.command(name, params)
      if (configured !== undefined) return configured
      const typed = terminals.command(name, params)
      if (typed !== undefined) return typed
      const browsed = files.command(name, params, signal)
      if (browsed !== undefined) return browsed
      const composed = compose.command(name, params)
      if (composed !== undefined) return composed
      const reviewed = diffs.command(name, params, signal)
      if (reviewed !== undefined) return reviewed
      const nested = tree.command(name, params)
      if (nested !== undefined) return nested
      if (name === 'session.markRead') {
        const { deviceId, sessionId } = params as { deviceId: string; sessionId: string }
        if (findSummary(deviceId, sessionId).unread)
          updateSummary(deviceId, sessionId, { unread: false })
        return {}
      }
      if (name === 'session.send') {
        const { text, images, extras, now, ...where } = params as Commands['session.send']['params']
        const message = outgoing(text, images, extras)
        const view = reachView(where)
        // 和真的核心一样：只读的会话（不接受直接输入的子代理、归档着的）发不了
        if (!view.live) throw new ChannelError('rejected', '这个会话是只读的')
        const turn = running(view)
        // 和真的核心一样：要求直接插进去、插得进去的不排队（插不进去的照常排着）
        if (
          now &&
          turn &&
          view.can.steer &&
          (view.can.steerImages || message.images.length === 0)
        ) {
          applySessionOps(view, [
            {
              op: 'item.add',
              turnId: turn.id,
              item: localUserMessage(`s${++seq}`, message, mentionsIn(view)),
            },
          ])
        } else if (turn) {
          applySessionOps(view, [
            { op: 'queue.set', queued: [...view.queued, { id: `q${++seq}`, ...message }] },
          ])
        } else {
          startTurn(view, message)
        }
        return {}
      }
      if (name === 'device.composeOptions') {
        // 一台设备上有几个 harness 时各有各的清单；没说要哪个的给第一个可用的那一份
        const { deviceId, harness } = params as Commands['device.composeOptions']['params']
        const device = app.devices.find((entry) => entry.id === deviceId)
        const first = device?.harnesses.find((entry) => entry.state === 'ready')
        return sampleOptions(harnessOn(deviceId, harness ?? first?.id ?? ''))
      }
      if (name === 'device.newSessionDefaults') {
        const { deviceId, harness } = params as Commands['device.newSessionDefaults']['params']
        const device = app.devices.find((entry) => entry.id === deviceId)
        const first = device?.harnesses.find((entry) => entry.state === 'ready')
        return sampleDefaults(harnessOn(deviceId, harness ?? first?.id ?? ''))
      }
      if (name === 'session.rename') {
        const { deviceId, sessionId, title } = params as Commands['session.rename']['params']
        updateSummary(deviceId, sessionId, { title: title.trim() })
        return {}
      }
      if (name === 'device.loadArchived') {
        const { deviceId } = params as Commands['device.loadArchived']['params']
        const sidebar = sidebars.get(deviceId)
        if (!sidebar) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
        sidebar.archived ??= []
        archivedChanged(deviceId)
        return {}
      }
      if (name === 'session.unarchive') {
        const { deviceId, sessionId } = params as Commands['session.unarchive']['params']
        const sidebar = sidebars.get(deviceId)
        const list = shelved.get(deviceId) ?? []
        const summary = list.find((entry) => entry.id === sessionId)
        if (!sidebar || !summary) throw new ChannelError('notFound', `没有这个会话：${sessionId}`)
        shelved.set(
          deviceId,
          list.filter((entry) => entry !== summary),
        )
        sidebar.sessions.push(summary)
        const ops: SidebarOp[] = [{ op: 'session.upsert', session: summary }]
        emit(`sidebar:${deviceId}`, ops)
        archivedChanged(deviceId)
        // 正只读地开着的：现在能发消息了
        const opened = sessions.get(`session:${deviceId}:${sessionId}`)
        if (opened && !opened.live) {
          applySessionOps(opened, [{ op: 'session.state', live: true, note: null }])
        }
        return {}
      }
      if (name === 'session.archive' || name === 'session.delete') {
        const { deviceId, sessionId } = params as Commands['session.archive']['params']
        const sidebar = sidebars.get(deviceId)
        const list = shelved.get(deviceId) ?? []
        const summary = sidebar?.sessions.find((entry) => entry.id === sessionId)
        if (!summary) {
          // 不在列表里：只能是删一个已归档的
          if (name !== 'session.delete' || !list.some((entry) => entry.id === sessionId))
            throw new ChannelError('notFound', `没有这个会话：${deviceId}/${sessionId}`)
          shelved.set(
            deviceId,
            list.filter((entry) => entry.id !== sessionId),
          )
          archivedChanged(deviceId)
          return {}
        }
        if (sidebar) sidebar.sessions = sidebar.sessions.filter((entry) => entry !== summary)
        replies.get(`session:${deviceId}:${sessionId}`)?.()
        // 归档的会话内容留着，恢复之后还是原来那些；删除的才清掉
        if (name === 'session.delete') sessions.delete(`session:${deviceId}:${sessionId}`)
        const ops: SidebarOp[] = [{ op: 'session.remove', sessionId }]
        emit(`sidebar:${deviceId}`, ops)
        if (name === 'session.archive') {
          shelved.set(deviceId, [...list, { ...summary, status: 'idle', waitingFor: null }])
          archivedChanged(deviceId)
        }
        return {}
      }
      if (name === 'session.configure') {
        const { settings, ...where } = params as Commands['session.configure']['params']
        const view = openView(where)
        applySessionOps(view, [
          { op: 'session.settings', settings: { ...view.settings, ...settings } },
        ])
        return {}
      }
      if (name === 'session.implementPlan') {
        const { text, ...where } = params as Commands['session.implementPlan']['params']
        const view = reachView(where)
        if (running(view)) throw new ChannelError('rejected', '回合还在进行，现在执行不了计划')
        applySessionOps(view, [
          { op: 'session.settings', settings: { ...view.settings, mode: 'default' } },
        ])
        startTurn(view, outgoing(text))
        return {}
      }
      if (name === 'session.create') {
        const {
          deviceId,
          harness: wanted,
          workspaceId,
          cwd,
          text,
          images,
          extras,
          settings,
          goal: asGoal,
          worktree: tree,
        } = params as Commands['session.create']['params']
        const message = outgoing(text, images, extras)
        const sidebar = sidebars.get(deviceId)
        if (!sidebar) throw new ChannelError('notFound', `没有这台设备：${deviceId}`)
        // 建在界面选的那个 harness 上；没选就是第一个可用的
        const all = app.devices.find((device) => device.id === deviceId)?.harnesses ?? []
        const harness = wanted ?? all.find((entry) => entry.state === 'ready')?.id
        if (!harness) {
          throw new ChannelError('rejected', '没有可用的 harness', phrase('fault.noHarness'))
        }
        if (!all.some((entry) => entry.id === harness)) {
          const unknown = phrase('fault.unknownHarness', { name: harness })
          throw new ChannelError('remote', `没有 ${harness}`, unknown)
        }
        mustBeUp(deviceId, harness)
        if (asGoal && !canOf(deviceId, harness).goals)
          throw new ChannelError('unsupported', '对面不支持这个操作')
        if (REFUSES_CREATE.test(text)) {
          throw new ChannelError('remote', SAMPLE_TEXT[lang].createRefused)
        }
        if (tree && cwd === null) throw new ChannelError('rejected', '没有工作区，建不了工作树')
        // 要新工作树的先建它（要一会儿），会话在它里面对应的子目录起
        const made =
          tree && cwd !== null
            ? await worktrees.create(deviceId, cwd, tree.from, text.split('\n')[0] ?? '')
            : null
        const summary: SessionSummary = {
          id: `new${++seq}`,
          // 界面说了建在哪个工作区就归在那里；没说的按工作目录去认
          workspaceId: organize.home(deviceId, workspaceId, cwd),
          harness,
          title: text.split('\n')[0]?.slice(0, 80) ?? '',
          status: 'idle',
          waitingFor: null,
          unread: false,
          updatedAt: clock.now(),
          cwd: made ? (made.subPath ? `${made.path}/${made.subPath}` : made.path) : (cwd ?? '~'),
          pinned: false,
          section: null,
          placedAt: null,
          task: null,
          lineage: null,
          nativeLineage: null,
          background: null,
          worktree: made ? shownOf(made) : null,
        }
        sidebar.sessions.push(summary)
        emit(`sidebar:${deviceId}`, [{ op: 'session.upsert', session: summary }])
        if (made) worktrees.own(deviceId, made.id, summary.id)
        const view: SessionView = {
          deviceId,
          sessionId: summary.id,
          title: summary.title,
          harness: summary.harness,
          cwd: summary.cwd,
          live: true,
          note: null,
          turns: [],
          items: {},
          requests: [],
          queued: [],
          settings: { ...sampleSettings(harnessOn(deviceId, harness)), ...settings },
          usage: null,
          can: canOf(deviceId, summary.harness),
          forkedFrom: null,
          proposals: [],
          agents: [],
        }
        sessions.set(sessionKey(view), view)
        // 第一句是持续目标：设下目标，不发消息，空闲时自己开始做（mock-goal.mts）
        if (asGoal) goal.set(view, { objective: text })
        else startTurn(view, message)
        return { sessionId: summary.id }
      }
      if (name === 'session.goal.set' || name === 'session.goal.clear') {
        const { deviceId, sessionId, ...change } = params as Commands['session.goal.set']['params']
        const view = reachView({ deviceId, sessionId })
        if (!view.can.goals) throw new ChannelError('unsupported', '对面不支持这个操作')
        if (!view.live) throw new ChannelError('rejected', '这个会话是只读的')
        if (name === 'session.goal.clear') goal.clear(view)
        else goal.set(view, change)
        return {}
      }
      if (name === 'session.interrupt') {
        const view = reachView(params as Commands['session.interrupt']['params'])
        const turn = running(view)
        if (!turn) throw new ChannelError('rejected', '没有可以打断的回合')
        replies.get(sessionKey(view))?.()
        if (sessionKey(view) === streamKey && streaming === 'running') {
          // 那个一打开就在流的示例会话走的是另一条路
          stopStream?.()
          stopStream = null
          streaming = 'done'
          replyItems.set(streamKey, { turnId: turn.id, itemId: STREAM_SESSION.itemId })
        }
        const current = replyItems.get(sessionKey(view))
        // 和真的核心一样：目标在做的时候按停止，先把目标暂停，免得停下来又接着续跑
        if (view.goal?.status === 'active') goal.set(view, { status: 'paused' })
        // 等着审批或回答的回合被打断：请求一并作废
        applySessionOps(
          view,
          view.requests.map((request) => ({ op: 'request.remove', requestId: request.id })),
        )
        endTurn(view, turn.id, current?.turnId === turn.id ? current.itemId : null, 'interrupted')
        return {}
      }
      if (name === 'session.steer') {
        const { messageId, ...where } = params as Commands['session.steer']['params']
        const view = openView(where)
        const message = view.queued.find((entry) => entry.id === messageId)
        const turn = running(view)
        if (!message || !turn) throw new ChannelError('rejected', '现在没有可以插话的回合')
        attempt(view, 'steer')
        if (!view.can.steerImages && message.images.length > 0) {
          throw new ChannelError(
            'rejected',
            '带图片的消息不能中途插进去',
            phrase('fault.steerImages'),
          )
        }
        applySessionOps(view, [
          { op: 'queue.set', queued: view.queued.filter((entry) => entry !== message) },
          {
            op: 'item.add',
            turnId: turn.id,
            item: localUserMessage(`s${++seq}`, message, mentionsIn(view)),
          },
        ])
        return {}
      }
      if (name === 'session.unqueue') {
        const { messageId, ...where } = params as Commands['session.unqueue']['params']
        const view = openView(where)
        applySessionOps(view, [
          { op: 'queue.set', queued: view.queued.filter((message) => message.id !== messageId) },
        ])
        return {}
      }
      if (name === 'session.respond') {
        const { requestId, optionId, note, answers, ...where } =
          params as Commands['session.respond']['params']
        const view = openView(where)
        const request = view.requests.find((entry) => entry.id === requestId)
        if (!request) throw new ChannelError('rejected', '这个请求已经不在了')
        const machineAsk = machineAsks.get(requestId)
        if (request.kind === 'clientAsk' && machineAsk) {
          // 远程设备操作这台电脑的卡片：允许了照常做完，拒绝了条目失败、理由带给模型
          const option = request.options.find((entry) => entry.id === optionId)
          if (!option) throw new ChannelError('rejected', '这个请求没有这样的选项')
          machineAsks.delete(requestId)
          const turn = running(view)
          applySessionOps(view, [{ op: 'request.remove', requestId }])
          if (option.role === 'acceptSession') machineGranted.add(sessionKey(view))
          if (!turn) return {}
          updateSummary(view.deviceId, view.sessionId, { status: 'running', waitingFor: null })
          if (option.role !== 'decline') {
            machineDone(view, turn.id, machineAsk.demo, machineAsk.itemId)
            return {}
          }
          const ask = machineDemoAsk(machineAsk.demo)
          machine.record({
            deviceId: view.deviceId,
            sessionId: view.sessionId,
            harness: view.harness,
            tool: machineAsk.demo === 'copy' ? 'copy' : 'exec',
            summary: machineSummary(ask),
            result: 'declined',
            flagged: ask.flagged.length > 0,
          })
          applySessionOps(view, [
            {
              op: 'item.add',
              turnId: turn.id,
              item: projectItem(machineToolCall(machineAsk.demo, machineAsk.itemId, 'declined')),
            },
          ])
          const said = note?.trim()
          if (said) heard.set(sessionKey(view), said)
          replyHeard(view, turn.id)
          return {}
        }
        if (request.kind === 'clientAsk') {
          // 客户端工具的卡片：答应了条目带着截图完成，拒绝了条目失败；然后照常回话
          const option = request.options.find((entry) => entry.id === optionId)
          if (!option) throw new ChannelError('rejected', '这个请求没有这样的选项')
          const demo = clientAsks.get(requestId)
          clientAsks.delete(requestId)
          const turn = running(view)
          const declined = option.role === 'decline'
          applySessionOps(view, [
            { op: 'request.remove', requestId },
            ...(demo && turn
              ? [
                  {
                    op: 'item.add',
                    turnId: turn.id,
                    item: projectItem(
                      clientToolCall(demo.demo, demo.itemId, declined ? 'declined' : 'shot'),
                    ),
                  } satisfies SessionOp,
                ]
              : []),
          ])
          if (!turn) return {}
          updateSummary(view.deviceId, view.sessionId, { status: 'running', waitingFor: null })
          replyHeard(view, turn.id)
          return {}
        }
        if (request.kind === 'question') {
          // 和真的核心一样再查一遍：每道题都要有个说法，答了或者明确跳过
          const settled = settleAnswers(request.questions, answers)
          if (!settled) throw new ChannelError('rejected', '这个请求没有这样的选项')
          // 计划确认：选了“执行”才退出计划模式，和真的引擎一样由对面自己改、再告诉这边
          const asked = request.questions[0]
          const chosen = asked ? settled[asked.id]?.[0] : undefined
          if (planAsks.delete(requestId) && chosen && chosen === asked?.options?.[0]?.label) {
            applySessionOps(view, [
              { op: 'session.settings', settings: { ...view.settings, mode: 'default' } },
            ])
          }
          const sample = SAMPLE_TEXT[lang]
          heard.set(
            sessionKey(view),
            request.questions
              .map(
                (entry) =>
                  `- ${entry.question} → ${settled[entry.id]?.[0] ?? sample.answerSkipped}`,
              )
              .join('\n'),
          )
        }
        const said = note?.trim() ?? ''
        const chosen =
          request.kind === 'approval'
            ? request.options.find((entry) => entry.id === optionId)
            : undefined
        if (said && !chosen?.note) throw new ChannelError('rejected', '这个选项不能附说明')
        const turn = running(view)
        const declined = optionId === 'decline' || optionId === 'cancel'
        applySessionOps(view, [
          { op: 'request.remove', requestId },
          // 附了说明的拒绝：对面听到了，回合里多一句话
          ...(said && turn
            ? [
                {
                  op: 'item.add',
                  turnId: turn.id,
                  item: {
                    id: `${turn.id}-n${++seq}`,
                    kind: 'agentMessage',
                    phase: 'commentary',
                    status: 'completed',
                    text: SAMPLE_TEXT[lang].declineHeard.replace('{note}', said),
                  },
                } satisfies SessionOp,
              ]
            : []),
          ...(request.itemId
            ? [
                {
                  op: 'item.status',
                  itemId: request.itemId,
                  status: declined ? 'declined' : 'completed',
                } satisfies SessionOp,
              ]
            : []),
        ])
        if (!turn) return {}
        const next = view.requests[0]
        if (optionId === 'cancel') {
          // 拒绝并停下：后面排着的请求一并作废
          applySessionOps(
            view,
            view.requests.map((entry) => ({ op: 'request.remove', requestId: entry.id })),
          )
          endTurn(view, turn.id, null, 'interrupted')
        } else if (next) {
          // 后面还有请求在等：回合接着停在那里
          updateSummary(view.deviceId, view.sessionId, {
            waitingFor: next.kind === 'approval' ? 'approval' : 'answer',
          })
        } else {
          updateSummary(view.deviceId, view.sessionId, { status: 'running', waitingFor: null })
          replyHeard(view, turn.id)
        }
        return {}
      }
      /** 切在回合中间：第 at 个回合里那条插进来的话的位置。会话不会这样切、不是插进来的话，都不行 */
      const cutIn = (view: SessionView, at: number, itemId: string): number => {
        if (!view.can.cutInTurn) throw new ChannelError('unsupported', '对方不支持此操作')
        const index = view.turns[at]?.itemIds.indexOf(itemId) ?? -1
        if (index < 1 || view.items[itemId]?.kind !== 'userMessage')
          throw new ChannelError('rejected', '这条消息不是插进这个回合的话')
        return index
      }
      if (name === 'session.fork') {
        const { turnId, itemId, ...where } = params as Commands['session.fork']['params']
        const view = reachView(where)
        if (running(view)) throw new ChannelError('rejected', '回合还在进行，结束之后才能分叉')
        const at = view.turns.findIndex((turn) => turn.id === turnId)
        const sidebar = sidebars.get(view.deviceId)
        if (at < 0 || !sidebar) throw new ChannelError('rejected', '这个回合已经不在了')
        attempt(view, 'fork')
        const cut = itemId === undefined ? -1 : cutIn(view, at, itemId)
        // 新会话里是到这个回合为止（含）的内容，名字和原来的一样
        const summary: SessionSummary = {
          ...findSummary(view.deviceId, view.sessionId),
          id: `fork${++seq}`,
          status: 'idle',
          waitingFor: null,
          unread: false,
          updatedAt: clock.now(),
          // 新会话不跟着原来的置顶、进分区，也不是谁的子会话
          pinned: false,
          section: null,
          placedAt: null,
          lineage: null,
          nativeLineage: null,
          background: null,
          worktree: null,
        }
        // 显示数据都是能写成 JSON 的，这样抄一份就和原来的互不相干了
        const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
        const turns = copy(view.turns.slice(0, at + 1))
        // 切在回合中间：这一回合只带到那条插进来的话之前
        const last = turns[at]
        if (last && cut >= 0) last.itemIds = last.itemIds.slice(0, cut)
        const items: SessionView['items'] = {}
        for (const turn of turns) {
          for (const id of turn.itemIds) {
            const item = view.items[id]
            if (item) items[id] = copy(item)
          }
        }
        sidebar.sessions.push(summary)
        emit(`sidebar:${view.deviceId}`, [{ op: 'session.upsert', session: summary }])
        sessions.set(`session:${view.deviceId}:${summary.id}`, {
          ...view,
          sessionId: summary.id,
          live: true,
          note: null,
          turns,
          items,
          requests: [],
          queued: [],
          forkedFrom: view.sessionId,
        })
        return { sessionId: summary.id }
      }
      if (name === 'session.rollback') {
        const { turnId, itemId, ...where } = params as Commands['session.rollback']['params']
        const view = reachView(where)
        if (running(view)) throw new ChannelError('rejected', '回合还在进行，结束之后才能回退')
        const at = view.turns.findIndex((turn) => turn.id === turnId)
        if (at < 0) throw new ChannelError('rejected', '这个回合已经不在了')
        attempt(view, 'rollback')
        // 切在回合中间：这一回合从那条插进来的话起拿掉，后面的回合整个拿掉
        const cut = itemId === undefined ? -1 : cutIn(view, at, itemId)
        const kept = cut >= 0 ? view.turns[at] : undefined
        applySessionOps(view, [
          ...(kept ? kept.itemIds.slice(cut) : []).map(
            (id): SessionOp => ({ op: 'item.remove', turnId: turnId, itemId: id }),
          ),
          ...view.turns
            .slice(kept ? at + 1 : at)
            .map((turn): SessionOp => ({ op: 'turn.remove', turnId: turn.id })),
        ])
        updateSummary(view.deviceId, view.sessionId, { updatedAt: clock.now() })
        return {}
      }
      if (name === 'session.compact') {
        const view = reachView(params as Commands['session.compact']['params'])
        if (running(view)) throw new ChannelError('rejected', '回合还在进行，结束之后才能压缩')
        attempt(view, 'compact')
        // 压缩是一个没有用户消息的回合：先是一行“正在压缩上下文”，过一会儿变成“上下文已压缩”，占用降下来
        const turnId = `m${++seq}`
        const compaction: ItemView = {
          id: `${turnId}-n`,
          kind: 'compaction',
          status: 'inProgress',
          source: 'manual',
        }
        applySessionOps(view, [
          {
            op: 'turn.add',
            turn: {
              id: turnId,
              status: 'running',
              itemIds: [],
              startedAt: clock.now(),
              durationMs: null,
              error: null,
            },
          },
          { op: 'item.add', turnId, item: compaction },
        ])
        updateSummary(view.deviceId, view.sessionId, { status: 'running', updatedAt: clock.now() })
        const finish = () => {
          applySessionOps(view, [
            { op: 'item.add', turnId, item: { ...compaction, status: 'completed' } },
            ...(view.usage
              ? [
                  {
                    op: 'session.usage',
                    usage: { ...view.usage, usedTokens: Math.round(view.usage.usedTokens * 0.3) },
                  } satisfies SessionOp,
                ]
              : []),
          ])
          endTurn(view, turnId, null, 'completed')
        }
        replies.set(sessionKey(view), clock.setTimer(finish, Math.max(chunkMs * 40, 1)))
        return {}
      }
      throw new ChannelError('unknownCommand', `不认识的命令：${name}`)
    },

    subscribe(topic, sink) {
      // 管理数据有自己的一套订阅者
      if (topic.kind === 'manage') return manage.subscribe(topic.deviceId, sink)
      // 终端也是：列表和各个终端的输出
      if (topic.kind === 'terminals' || topic.kind === 'terminal') {
        return terminals.subscribe(topic, sink)
      }
      if (topic.kind === 'diff') return diffs.subscribe(topic, sink)
      // 08 号：远程会话在这台电脑上的动静（mock-machine.mts）
      if (topic.kind === 'machine') return machine.subscribe(sink)
      // 定时任务（mock-tasks.mts）
      if (topic.kind === 'tasks') return tasks.subscribe(topic.deviceId, sink)
      // 扫码绑定手机（mock-pairing.mts）
      if (topic.kind === 'pairing') return pairing.subscribe(topic.deviceId, sink)
      // 手机批准（mock-approvals.mts）
      if (topic.kind === 'approvals') return approvals.subscribe(topic.deviceId, sink)
      // 给设备装 harness（mock-install.mts）、litch config（mock-config.mts）
      if (topic.kind === 'install') return install.subscribe(topic.deviceId, sink)
      // 工作树（mock-worktrees.mts）
      if (topic.kind === 'worktrees') return worktrees.subscribe(topic.deviceId, sink)
      if (topic.kind === 'harnessConfig') {
        return harnessConfig.subscribe(topic.deviceId, topic.harness, sink)
      }
      if (topic.kind === 'config') return config.subscribe(sink)
      // 账号额度（mock-limits.mts）：只给快照
      if (topic.kind === 'accountLimits') {
        sink.snapshot(mockAccountLimits(topic.deviceId, topic.harness, clock.now()))
        return () => {}
      }
      const key = topicKey(topic)
      if (topic.kind === 'app') {
        sink.snapshot(app)
      } else if (topic.kind === 'sidebar') {
        const view = sidebars.get(topic.deviceId)
        if (!view) throw new ChannelError('notFound', `没有这台设备：${topic.deviceId}`)
        sink.snapshot(view)
      } else {
        const view = loadSession(topic.deviceId, topic.sessionId)
        sink.snapshot(view)
        // 打开了任务跑出来的会话：里面跑完的运行算看过了
        tasks.seen(topic.deviceId, topic.sessionId)
        if (
          topic.deviceId === STREAM_SESSION.deviceId &&
          topic.sessionId === STREAM_SESSION.sessionId
        ) {
          startStream(view)
        }
      }
      const set = sinks.get(key) ?? new Set<HostSink>()
      sinks.set(key, set)
      set.add(sink)
      return () => {
        set.delete(sink)
        // 那个“进行中”的会话没人看了就复位，下次打开从头再流一遍，方便反复看流式的效果
        if (key === streamKey && set.size === 0) {
          stopStream?.()
          stopStream = null
          streaming = 'idle'
          sessions.delete(key)
          updateSummary(STREAM_SESSION.deviceId, STREAM_SESSION.sessionId, { status: 'running' })
        }
      }
    },
  }
  return core
}
