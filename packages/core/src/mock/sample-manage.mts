// 模拟核心用的示例数据：设备与 harness 管理（设置的结构、一开始的值、环境文件里的变量）。
// 设置有哪些由“设备服务”声明，界面按类型画——这里就是那个声明。各种类型都放了几项，
// 还有一项故意用了这一版界面不认识的类型，用来看兜底。内容全是编出来的。
// 给人看的字本来就要两种语言各一份（界面按当前语言取），所以直接写在这里，不放进 sample-text.mts。
import { taskCardsSettingKey } from '../../../protocol/src/session-tree.mjs'
import type { Bilingual, HarnessView } from '../model.mjs'
import type {
  InheritedEnvView,
  SettingGroupView,
  SettingSpecView,
  SettingValueView,
} from '../model-manage.mjs'

export const both = (zh: string, en: string): Bilingual => ({ 'zh-CN': zh, en })

/** 多数设置项用不到的那几样 */
const BASE: Pick<SettingSpecView, 'role' | 'minimum' | 'maximum' | 'options'> = {
  role: null,
  minimum: null,
  maximum: null,
  options: [],
}

/** 一台设备上的设置：结构，和设置里已经写过的值 */
export interface SampleSettings {
  groups: SettingGroupView[]
  settings: SettingSpecView[]
  /**
   * 写过的值，键是设置项的键。密钥只记“设过了”，环境变量表里的密钥没有值：
   * 模拟核心里根本不留密钥，写进来的密钥当场丢掉
   */
  written: Map<string, SettingValueView>
  inheritedEnv: InheritedEnvView[]
  /** 一开始就等着重启的 harness */
  pendingRestart: string[]
  /** 示例里被别的程序占着的端口：开在这个端口上的入口起不来 */
  takenPort: number | null
}

/**
 * 每个 harness 都有的三项：启用、命令行路径、环境变量。
 * 启用那一项带着角色标记，界面凭它把开关放到标题行上。codex 那一组故意把它排在第二：
 * 验收靠这一处确认界面认的是标记，不是“排在最前面的开关”
 */
function harnessSettings(harness: HarnessView): SettingSpecView[] {
  const scope = { kind: 'harness', harness: harness.id } as const
  const group = `harness.${harness.id}`
  const { name } = harness
  const [enabled, cliPath, env] = baseSettings(group, scope, name)
  return harness.id === 'codex' ? [cliPath, enabled, env] : [enabled, cliPath, env]
}

function baseSettings(
  group: string,
  scope: SettingSpecView['scope'],
  name: string,
): [SettingSpecView, SettingSpecView, SettingSpecView] {
  return [
    {
      ...BASE,
      key: `${group}.enabled`,
      group,
      type: 'boolean',
      scope,
      default: true,
      restart: 'harness',
      role: 'enable',
      title: both('启用', 'Enabled'),
      description: both(
        `关掉之后 ${name} 的运行时会停下来，这台设备不再提供它。会话都留着，重新打开就回来。`,
        `Turning this off stops the ${name} runtime and this device stops offering it. Sessions are kept and return when you turn it back on.`,
      ),
    },
    {
      ...BASE,
      key: `${group}.cliPath`,
      group,
      type: 'path',
      scope,
      default: '',
      restart: 'harness',
      title: both('命令行路径', 'CLI path'),
      description: both(
        `这台设备上 ${name} 命令行的绝对路径。留空就到 PATH 里去找。`,
        `Absolute path to the ${name} command-line tool on this device. Leave it empty to search PATH.`,
      ),
    },
    {
      ...BASE,
      key: `${group}.env`,
      group,
      type: 'env',
      scope,
      default: [],
      restart: 'harness',
      title: both('环境变量', 'Environment variables'),
      description: both(
        `只给 ${name} 的运行时用：代理、接口地址、密钥之类。同名的变量以这里为准。`,
        `Used only by the ${name} runtime: proxy, API endpoint, keys and the like. A variable set here wins over one with the same name elsewhere.`,
      ),
    },
  ]
}

/** 任务卡按 harness 的开关：和设备服务声明的那一项同形（键是 harness.<id>.taskCards，默认开，不用重启） */
function taskCardsSetting(harness: HarnessView): SettingSpecView {
  return {
    ...BASE,
    key: taskCardsSettingKey(harness.id),
    group: `harness.${harness.id}`,
    type: 'boolean',
    scope: { kind: 'harness', harness: harness.id },
    default: true,
    restart: 'none',
    title: both('任务卡', 'Task cards'),
    description: both(
      '会话里出建议任务卡片、回合末尾收尾。关掉后这个 harness 的会话不再提建议，派子会话等其余能力照旧。',
      'Sessions suggest follow-up tasks as cards and wrap up each turn. When off, sessions on this harness stop suggesting; starting sub-sessions and the rest still work.',
    ),
  }
}

/** 个别 harness 多出来的几项，各是一种类型 */
function extraSettings(harness: HarnessView): SettingSpecView[] {
  const scope = { kind: 'harness', harness: harness.id } as const
  const group = `harness.${harness.id}`
  if (harness.id === 'claude') {
    return [
      {
        ...BASE,
        key: `${group}.idleExitMinutes`,
        group,
        type: 'integer',
        scope,
        default: 30,
        restart: 'none',
        minimum: 0,
        maximum: 1440,
        title: both('空闲多久后退出（分钟）', 'Exit after idle (minutes)'),
        description: both(
          '没有会话在用它的时候，运行时等这么久就自己退出，下次用到再起。填 0 表示一直留着。',
          'With no session using it, the runtime exits after this long and starts again on demand. 0 keeps it running.',
        ),
      },
      {
        ...BASE,
        key: `${group}.logLevel`,
        group,
        type: 'enum',
        scope,
        default: 'info',
        restart: 'harness',
        title: both('日志详细程度', 'Log level'),
        description: both(
          '排查问题时调高；越详细日志文件长得越快。',
          'Raise it while troubleshooting; more detail makes the log file grow faster.',
        ),
        options: [
          { value: 'info', title: both('一般', 'Info') },
          { value: 'debug', title: both('详细', 'Debug') },
          { value: 'trace', title: both('逐条协议消息', 'Trace every protocol message') },
        ],
      },
      {
        ...BASE,
        // 和设备服务真实声明的那一项同形（cmd/codex-harness-adapter/settings_claude.go）
        key: `${group}.promptCacheTtl`,
        group,
        type: 'enum',
        scope,
        default: 'default',
        restart: 'harness',
        title: both('提示缓存时长', 'Prompt cache duration'),
        description: both(
          'Claude 会把对话里前面不变的部分缓存起来，下一轮再用时更便宜也更快。官方默认缓存 5 分钟（用 Claude 订阅登录时是 1 小时）。改成 1 小时后，长对话里隔一阵再接着聊也还接得上缓存，少花重新写入的钱；但每次写入缓存的单价更高（约为普通输入的 2 倍，5 分钟缓存是 1.25 倍），所以短对话、聊完就走的用法不一定划算。子代理和后台请求仍用 5 分钟。改了之后 Claude Code 重启才生效。',
          'Claude caches the unchanged start of a conversation so the next turn costs less and responds faster. By default the cache lasts 5 minutes (1 hour when signed in with a Claude subscription). With 1 hour, long conversations still hit the cache after a pause, so you pay less for writing it again; but each cache write costs more (about 2× normal input, versus 1.25× for the 5-minute cache), so it may not pay off for short, one-off chats. Subagents and background requests keep 5 minutes. Takes effect after Claude Code restarts.',
        ),
        options: [
          { value: 'default', title: both('跟官方一致', 'Same as Claude Code') },
          { value: '1h', title: both('1 小时', '1 hour') },
        ],
      },
      {
        ...BASE,
        // 和设备服务真实声明的那一项同形（cmd/codex-harness-adapter/settings_claude.go）
        key: `${group}.crossSessionInbox`,
        group,
        type: 'boolean',
        scope,
        default: true,
        restart: 'harness',
        title: both('接收别的 Claude 会话的消息', 'Messages from other Claude sessions'),
        description: both(
          '开着时，这台设备上别的 Claude 会话（Claude 桌面端、终端里的 Claude Code、Litch 里别的 Claude 会话）可以用 SendMessage 给这里的会话发消息，会话收到后会自己开一个回合处理，对话里显示是谁发来的。对方的请求按收到消息的会话自己的权限执行：完全访问的会话不会再问你。回合结束后，会话按“空闲会话保持在线”再留一阵，留着时也收得到。关掉之后这里的会话不出现在别的会话的列表里，也收不到。改了之后 Claude Code 重启才生效。',
          "While on, other Claude sessions on this device (the Claude desktop app, Claude Code in a terminal, other Claude sessions in Litch) can message sessions here with SendMessage; the session starts a turn to handle it, and the conversation shows who sent it. The request runs with the receiving session's own permissions: a full-access session will not ask you. After a turn ends, the session stays reachable for as long as “Keep idle sessions online” allows. When off, sessions here are not listed to other sessions and receive nothing. Takes effect after Claude Code restarts.",
        ),
      },
      {
        ...BASE,
        key: `${group}.idleKeepAlive`,
        group,
        type: 'enum',
        scope,
        default: '1h',
        restart: 'harness',
        title: both('空闲会话保持在线', 'Keep idle sessions online'),
        options: [
          { value: 'off', title: both('关', 'Off') },
          { value: '15m', title: both('15 分钟', '15 minutes') },
          { value: '1h', title: both('1 小时', '1 hour') },
          { value: '4h', title: both('4 小时', '4 hours') },
        ],
        description: both(
          '会话的回合结束后，它的 Claude Code 进程再留这么久，期间别的 Claude 会话发来的消息照样收得到，接着聊也不用重新启动。每个留着的会话约占 100–200MB 内存，最多同时留 8 个（和看管后台命令的进程共用这个上限），满了先关闲得最久的。只在开着“接收别的 Claude 会话的消息”时生效。改了之后 Claude Code 重启才生效。',
          "After a session's turn ends, its Claude Code process stays this long, so messages from other Claude sessions still arrive and the next turn needs no restart. Each kept session uses about 100–200 MB of memory; at most 8 are kept at once (shared with processes keeping background commands), and the one idle longest closes first. Applies only while “Messages from other Claude sessions” is on. Takes effect after Claude Code restarts.",
        ),
      },
    ]
  }
  if (harness.id === 'pi') {
    return [
      {
        ...BASE,
        key: `${group}.endpoint`,
        group,
        type: 'string',
        scope,
        default: '',
        restart: 'harness',
        title: both('模型接口地址', 'Model endpoint'),
        description: both(
          '留空就用 Pi 自己配置里的那个。',
          'Leave it empty to use the one in Pi’s own configuration.',
        ),
      },
      {
        ...BASE,
        key: `${group}.apiKey`,
        group,
        type: 'secret',
        scope,
        default: { set: false },
        restart: 'harness',
        title: both('模型接口的密钥', 'Model API key'),
        description: both(
          '只能填新的，填过的不会再显示出来。',
          'You can only enter a new one; a saved key is never shown again.',
        ),
      },
    ]
  }
  if (harness.id === 'dsh') {
    return [
      {
        ...BASE,
        key: `${group}.wakeSchedule`,
        group,
        // 这一版界面不认识的类型：看兜底
        type: 'schedule',
        scope,
        default: 'weekdays 09:00',
        restart: 'none',
        title: both('定时唤醒', 'Scheduled wake-up'),
        description: both(
          '到点把排着的任务接着做下去。',
          'Picks queued tasks back up at the scheduled time.',
        ),
      },
    ]
  }
  return []
}

/** 设备级的两组：给官方桌面端的 SSH 入口、可重连的终端 */
function deviceSettings(harnesses: HarnessView[], firstPort: number): SettingSpecView[] {
  const scope = { kind: 'device' } as const
  const entries = harnesses.flatMap((harness, index): SettingSpecView[] => [
    {
      ...BASE,
      key: `ssh.${harness.id}.enabled`,
      group: 'ssh',
      type: 'boolean',
      scope,
      default: false,
      restart: 'none',
      title: both(`${harness.name} 入口`, `${harness.name} entry`),
      description: both(
        `开着的时候，Codex 桌面端可以经 SSH 连到 ${harness.name}。关掉会断开它在这个入口上的连接。`,
        `While on, the Codex desktop app can reach ${harness.name} over SSH. Turning it off drops its connections on this entry.`,
      ),
    },
    {
      ...BASE,
      key: `ssh.${harness.id}.port`,
      group: 'ssh',
      type: 'integer',
      scope,
      default: firstPort + index,
      restart: 'none',
      minimum: 1,
      maximum: 65535,
      title: both(`${harness.name} 入口的端口`, `${harness.name} entry port`),
      description: both(
        '只在 127.0.0.1 上监听。各入口的端口不能相同；改了之后 Codex 桌面端那边的 ssh 配置也要跟着改。',
        'Listens on 127.0.0.1 only. Each entry needs its own port; after a change the ssh config on the Codex desktop side has to follow.',
      ),
    },
  ])
  return [
    ...entries,
    {
      ...BASE,
      key: 'terminal.scrollback',
      group: 'terminal',
      type: 'integer',
      scope,
      default: 10000,
      restart: 'none',
      minimum: 1000,
      maximum: 1000000,
      title: both('保留多少行输出', 'Scrollback lines'),
      description: both(
        '终端断开再连上时，能补回来这么多行。',
        'How many lines can be replayed when a terminal reconnects.',
      ),
    },
    {
      ...BASE,
      key: 'terminal.keepAlive',
      group: 'terminal',
      type: 'enum',
      scope,
      default: 'hour',
      restart: 'none',
      title: both('没人连着时保留多久', 'Keep unattended terminals for'),
      description: both(
        '超过这个时间还没人连回来，终端和里面的进程一起结束。',
        'A terminal nobody reconnects to within this time is ended together with its processes.',
      ),
      options: [
        { value: 'tenMinutes', title: both('10 分钟', '10 minutes') },
        { value: 'hour', title: both('1 小时', '1 hour') },
        { value: 'day', title: both('1 天', '1 day') },
        { value: 'forever', title: both('一直留着', 'Forever') },
      ],
    },
  ]
}

/** 这台设备上的设置。哪几台设备能管理由 sample-data.mts 的 manageable 决定 */
export function sampleSettings(deviceId: string, harnesses: HarnessView[]): SampleSettings {
  const local = deviceId === 'local'
  const firstPort = local ? 22230 : 22330
  const groups: SettingGroupView[] = [
    ...harnesses.map(
      (harness): SettingGroupView => ({
        id: `harness.${harness.id}`,
        title: both(harness.name, harness.name),
        description: null,
        scope: { kind: 'harness', harness: harness.id },
      }),
    ),
    {
      id: 'ssh',
      title: both('给 Codex 桌面端的 SSH 入口', 'SSH entries for the Codex desktop app'),
      description: both(
        '官方的 Codex 桌面端经这些入口连到各个 harness。只在本机回环地址上监听；Litch 自己不走它们。',
        'The official Codex desktop app reaches each harness through these entries. They listen on the loopback address only; Litch itself does not use them.',
      ),
      scope: { kind: 'device' },
    },
    {
      id: 'terminal',
      title: both('可重连的终端', 'Reconnectable terminals'),
      description: null,
      scope: { kind: 'device' },
    },
  ]
  const settings = [
    ...harnesses.flatMap((harness) => [
      ...harnessSettings(harness),
      ...extraSettings(harness),
      taskCardsSetting(harness),
    ]),
    ...deviceSettings(harnesses, firstPort),
  ]
  const has = (id: string) => harnesses.some((harness) => harness.id === id)
  const written = new Map<string, SettingValueView>()
  if (local) {
    if (has('claude')) {
      written.set('harness.claude.env', [
        { name: 'HTTPS_PROXY', value: 'http://127.0.0.1:7890' },
        { name: 'ANTHROPIC_API_KEY', secret: true },
      ])
      written.set('ssh.claude.enabled', true)
    }
    if (has('pi')) {
      written.set('harness.pi.endpoint', 'https://gate.example.com/v1')
      written.set('harness.pi.apiKey', { set: true })
      // 本机上 Pi 的任务卡关着：设置页那棵树上本机一行是半选
      written.set(taskCardsSettingKey('pi'), false)
      written.set('ssh.pi.enabled', true)
    }
  } else {
    if (has('claude')) written.set('harness.claude.cliPath', '/opt/claude/bin/claude')
    // 远程那台上的 Gemini CLI 停用着（sample-data.mts），任务卡也关着：启用后树上那一行是空的
    if (has('gemini')) {
      written.set('harness.gemini.enabled', false)
      written.set(taskCardsSettingKey('gemini'), false)
    }
  }
  return {
    groups,
    settings,
    written,
    inheritedEnv: local
      ? [
          { name: 'NO_PROXY', value: 'localhost,127.0.0.1', secret: false },
          { name: 'OPENAI_API_KEY', secret: true },
        ]
      : [],
    // 远程那台一开始就有一个 harness 等着重启：改过它的设置，当时它有回合在跑
    pendingRestart: !local && has('pi') ? ['pi'] : [],
    // 本机上 Pi 入口的默认端口被别的程序占着
    takenPort: local ? firstPort + 1 : null,
  }
}
