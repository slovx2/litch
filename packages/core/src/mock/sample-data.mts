// 模拟核心用的示例数据：四台设备，覆盖在线、远程、只有 codex、离线四种情况。
// 内容和界面稿（设计目录的 ui/v1）是同一套，全是编出来的。文字在 sample-text.mts 里，中英文各一份。
import type {
  AppView,
  ComposeOptions,
  DeviceView,
  DiscoveredHost,
  FormField,
  HarnessView,
  ItemView,
  PermissionPreset,
  QuestionView,
  RequestView,
  SectionView,
  SessionDefaults,
  SessionSettings,
  SessionStatus,
  SessionSummary,
  SessionView,
  SidebarView,
  TurnView,
  WireColor,
} from '../model.mjs'
import { phrase } from '../phrase.mjs'
import { ALL_ABLE } from '../projection/session.mjs'
import { BUILTIN_PERMISSIONS } from '../projection/settings.mjs'
import { sampleHarness, samplePresets, takesNote } from './sample-harness.mjs'
import { sampleMachineAccess } from './sample-machine.mjs'
import { sampleLocalService, sampleRemoteService } from './sample-service.mjs'
import {
  SAMPLE_TEXT,
  type SampleLang,
  type SampleQuestion,
  type SampleText,
} from './sample-text.mjs'

/** 表单里一栏的底子：一行可以不填的字 */
const FIELD: FormField = {
  id: '',
  label: '',
  note: '',
  required: false,
  kind: 'text',
  format: null,
  options: [],
  initial: null,
  limits: { min: null, max: null, minLength: null, maxLength: null },
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * “添加设备”里从 ssh 配置发现到的主机，和它们连过去各是什么结果：
 * service 是装了设备服务（适配器）、正在跑，上面有几个 harness；idle 是装了但服务没在跑；
 * codex 是只有 Codex、能连；bare 是什么都没装；untrusted 是主机密钥还没被信任。
 */
export const SAMPLE_HOSTS: (DiscoveredHost & {
  result: 'service' | 'idle' | 'codex' | 'bare' | 'untrusted'
})[] = [
  { alias: 'build-01', host: '10.0.3.11', user: 'dev', port: 22, result: 'codex' },
  { alias: 'build-02', host: '10.0.3.12', user: 'dev', port: 22, result: 'service' },
  { alias: 'staging', host: 'staging.example.com', user: 'deploy', port: 2222, result: 'idle' },
  { alias: 'pi-lab', host: 'pi-lab.local', user: 'pi', port: 22, result: 'bare' },
  { alias: 'bastion', host: 'bastion.example.com', user: 'ops', port: 22, result: 'untrusted' },
]

export function sampleApp(_lang: SampleLang, now: number): AppView {
  const harness = sampleHarness
  const devices: DeviceView[] = [
    {
      id: 'local',
      name: phrase('device.local'),
      host: 'dev@macbook',
      kind: 'local',
      target: null,
      wire: 'green',
      connection: 'online',
      mode: 'full',
      os: 'macos',
      harnesses: [
        harness('claude'),
        harness('pi'),
        harness('dsh'),
        // 不可用的那一个：这台机器上没装 codex。种类是认识的，界面说得出原因和下一步；设备的原话放在后面
        harness('codex', {
          down: {
            kind: 'notInstalled',
            reason: 'harness.notInstalled',
            // 设备服务把原话的两种语言版本都给了：界面按当前的语言挑
            detail: {
              'zh-CN': SAMPLE_TEXT['zh-CN'].harnessReason,
              en: SAMPLE_TEXT.en.harnessReason,
            },
          },
        }),
      ],
      stranded: [],
      note: null,
      failure: null,
      stale: false,
      organizable: true,
      manageable: true,
      // 在跑的就是应用自带的那一份。别的情形由对话里的关键字来演（mock-service.mts）
      ...sampleLocalService(now),
      // 设备设置页的两个开关：默认浏览器开、Computer Use 关
      tools: { browser: true, computer: false },
      machine: null,
      // 会话树：对话里说“派子会话”“提个子会话”“用子代理”各演一出（mock-tree.mts）
      sessionTree: true,
      // 扫码绑定手机：出码之后过几秒“手机”来登记（mock-pairing.mts）
      pairing: true,
      // 给 harness 安装：版本、安装进度、失败回退（mock-install.mts）
      install: true,
    },
    {
      id: 'build',
      name: 'build-01',
      host: 'dev@build-01',
      kind: 'ssh',
      target: { kind: 'alias', alias: 'build-01' },
      wire: 'orange',
      connection: 'online',
      mode: 'full',
      os: 'linux',
      // 这台上的 Codex 是可用的：设备服务代它报的声明里没有我们的扩展，它的审批带不了说明。
      // OpenCode 只在这台上有（详情设置的示例凑齐五家，mock-harness-config.mts）；
      // 这台上的 dsh 是旧版，声明里还没有详情设置（设备支持、它不支持的样子）
      harnesses: [
        harness('claude'),
        harness('pi'),
        harness('dsh', { configurable: false }),
        harness('codex'),
        harness('opencode'),
      ],
      stranded: [],
      note: null,
      failure: null,
      stale: false,
      organizable: true,
      manageable: true,
      // 远程设备上的服务也看得到是哪一份；换版本是那台机器上的事，这边没有
      service: sampleRemoteService(now),
      upgrade: null,
      tools: { browser: true, computer: false },
      // 08 号：远程设备“操作这台电脑”。示例里只有 build-01 开着
      machine: sampleMachineAccess('build'),
      sessionTree: true,
      pairing: true,
      install: true,
    },
    {
      id: 'nas',
      name: 'nas',
      host: 'admin@nas.lan',
      kind: 'ssh',
      target: { kind: 'host', host: 'nas.lan', port: null, user: 'admin', keyFile: null },
      wire: 'yellow',
      connection: 'online',
      mode: 'single',
      os: 'linux',
      // 直接连的原生 codex 自己的入口：没有声明，它会什么试了才知道
      harnesses: [harness('codex', { declared: false })],
      stranded: [],
      note: null,
      failure: null,
      stale: false,
      organizable: true,
      // 只有原生 codex：没有设置接口，设备详情里只有连接信息
      manageable: false,
      // 也没有设备服务
      service: null,
      upgrade: null,
      tools: { browser: true, computer: false },
      machine: sampleMachineAccess('nas'),
      // 只有原生 codex：没有设备服务，也就没有会话树
      sessionTree: false,
      pairing: false,
      install: false,
    },
    {
      id: 'gpu',
      name: 'gpu-box',
      host: 'dev@gpu-box',
      kind: 'ssh',
      target: { kind: 'alias', alias: 'gpu-box' },
      wire: 'violet',
      connection: 'reconnecting',
      mode: 'full',
      // 这次运行里还没连上过：对面是什么系统还不知道
      os: null,
      harnesses: [harness('claude'), harness('pi')],
      stranded: [],
      note: phrase('ssh.unreachable'),
      failure: {
        stage: 'unreachable',
        text: phrase('ssh.unreachable'),
        detail: 'ssh: connect to host gpu-box port 22: Operation timed out',
        retrying: true,
      },
      // 侧栏里是上次连着的时候留下的那些会话
      stale: true,
      // 没连着，整理不了
      organizable: false,
      // 断开之前知道它有设置接口；现在连不上，管理不了
      manageable: true,
      // 这次运行里还没连上过：在跑的是哪一份不知道
      service: null,
      upgrade: null,
      tools: { browser: true, computer: false },
      machine: sampleMachineAccess('gpu'),
      sessionTree: true,
      // 断开之前知道它支持；现在连不上，出不了码
      pairing: true,
      install: true,
    },
  ]
  return { devices }
}

type Row = [
  id: string,
  workspaceId: string | null,
  harness: string,
  status: SessionStatus,
  ageMs: number,
  extra?: Partial<SessionSummary>,
]

const summaries = (
  text: SampleText,
  now: number,
  roots: Map<string, string>,
  rows: Row[],
): SessionSummary[] =>
  rows.map(([id, workspaceId, harnessId, status, ageMs, extra]) => ({
    id,
    workspaceId,
    harness: harnessId,
    title: text.titles[id] ?? id,
    status,
    waitingFor: null,
    unread: false,
    updatedAt: now - ageMs,
    cwd: (workspaceId && roots.get(workspaceId)) || '~',
    pinned: false,
    section: null,
    placedAt: null,
    task: null,
    lineage: null,
    nativeLineage: null,
    background: null,
    ...extra,
  }))

function sidebar(
  text: SampleText,
  deviceId: string,
  now: number,
  workspaces: [id: string, name: string, root: string, color?: WireColor][],
  rows: Row[],
): SidebarView {
  const roots = new Map(workspaces.map(([id, , root]) => [id, root]))
  const sessions = summaries(text, now, roots, rows)
  // 组就是会话上出现过的那几个
  const sections = new Map<string, SectionView>()
  for (const session of sessions) {
    if (session.section) sections.set(session.section.id, session.section)
  }
  return {
    deviceId,
    workspaces: workspaces.map(([id, name, root, color]) => ({
      id,
      name,
      roots: [root],
      color: color ?? null,
      pinned: false,
      sectionId: null,
    })),
    sections: [...sections.values()],
    sessions,
    archived: null,
  }
}

/** 本机上已经归档的两个会话。界面要的时候模拟核心才给 */
export function sampleArchived(now: number, lang: SampleLang): Map<string, SessionSummary[]> {
  const roots = new Map([['litch', '~/work/litch']])
  const rows: Row[] = [
    ['a1', 'litch', 'claude', 'idle', 9 * 24 * HOUR],
    ['a2', 'litch', 'pi', 'idle', 21 * 24 * HOUR],
  ]
  return new Map([['local', summaries(SAMPLE_TEXT[lang], now, roots, rows)]])
}

export function sampleSidebars(now: number, lang: SampleLang): SidebarView[] {
  const text = SAMPLE_TEXT[lang]
  return [
    sidebar(
      text,
      'local',
      now,
      [
        // 这一个挑过颜色
        ['litch', 'litch', '~/work/litch', 'blue'],
        ['docs', 'docs-site', '~/work/docs-site'],
      ],
      [
        // 置顶的两个：单列在设备下面最前头，不再出现在各自的工作区里。先置顶的在前
        [
          'p1',
          'litch',
          'claude',
          'idle',
          4 * HOUR,
          { pinned: true, placedAt: now - 9 * 24 * HOUR },
        ],
        [
          'p2',
          'docs',
          'pi',
          'idle',
          3 * 24 * HOUR,
          { pinned: true, placedAt: now - 2 * 24 * HOUR },
        ],
        // 在别的客户端里放进了一个自定义分区的
        [
          'k1',
          'litch',
          'claude',
          'idle',
          2 * 24 * HOUR,
          {
            section: { id: 'sec-later', name: text.sectionLater },
            placedAt: now - 2 * 24 * HOUR,
          },
        ],
        ['s1', 'litch', 'claude', 'running', 0],
        ['s2', 'litch', 'claude', 'waiting', 3 * MINUTE, { waitingFor: 'approval' }],
        ['s3', 'litch', 'pi', 'idle', 12 * MINUTE, { unread: true }],
        ['s4', 'litch', 'dsh', 'idle', HOUR],
        // Claude 桌面端从 s1 派出来的 Claude Code 会话：侧栏默认不显示，“更多”里打开才有，挂在 s1 下面
        [
          'cd1',
          'litch',
          'claude',
          'idle',
          5 * HOUR,
          { nativeLineage: { app: 'claude-desktop', parentId: 's1', createdAt: now - 6 * HOUR } },
        ],
        ['s5', 'litch', 'codex', 'idle', 26 * HOUR],
        ['s6', 'docs', 'claude', 'idle', 2 * HOUR],
        ['s7', 'docs', 'pi', 'idle', 40 * MINUTE, { unread: true }],
        ['s8', 'docs', 'claude', 'idle', 5 * 24 * HOUR],
        // 这个工作区会话多：侧栏只露出最近的几个，其余的收在“展示更多”后面
        // 在工作区的子目录里开的：行上多一个小记号
        ['d1', 'docs', 'claude', 'idle', 6 * 24 * HOUR, { cwd: '~/work/docs-site/content/guide' }],
        ['d2', 'docs', 'pi', 'idle', 8 * 24 * HOUR],
        ['d3', 'docs', 'claude', 'idle', 9 * 24 * HOUR],
        ['d4', 'docs', 'codex', 'idle', 12 * 24 * HOUR],
        ['d5', 'docs', 'claude', 'idle', 15 * 24 * HOUR],
        ['d6', 'docs', 'dsh', 'idle', 19 * 24 * HOUR],
        ['d7', 'docs', 'claude', 'idle', 23 * 24 * HOUR],
        ['d8', 'docs', 'pi', 'idle', 30 * 24 * HOUR],
        ['d9', 'docs', 'claude', 'idle', 41 * 24 * HOUR],
        // 不属于任何工作区的：它的工作目录是“添加工作区”时可以直接挑的候选
        ['s9', null, 'claude', 'idle', 3 * 24 * HOUR, { cwd: '/Users/dev/notes/launchd' }],
      ],
    ),
    sidebar(
      text,
      'build',
      now,
      [
        ['litch2', 'litch', '/srv/work/litch'],
        ['infra', 'infra', '/srv/work/infra'],
      ],
      [
        ['b1', 'litch2', 'claude', 'waiting', 8 * MINUTE, { waitingFor: 'answer' }],
        ['b2', 'litch2', 'pi', 'idle', 20 * MINUTE],
        // 工作目录和工作区的根不是一回事的两种：在子目录里开的；目录根本不在这个工作区里的（从别处挪进来的）
        ['b3', 'litch2', 'claude', 'idle', 2 * HOUR, { cwd: '/srv/work/litch/apps/desktop' }],
        ['b4', 'infra', 'dsh', 'error', 3 * HOUR],
        ['b5', 'infra', 'claude', 'idle', 6 * 24 * HOUR, { cwd: '/var/cache/ci' }],
        ['b6', 'litch2', 'codex', 'idle', 5 * HOUR],
      ],
    ),
    sidebar(
      text,
      'nas',
      now,
      [['bk', 'backup-scripts', '~/backup-scripts']],
      [['n1', 'bk', 'codex', 'idle', 3 * 24 * HOUR]],
    ),
    sidebar(
      text,
      'gpu',
      now,
      [['lab', 'train-lab', '~/train-lab']],
      [
        ['g1', 'lab', 'pi', 'idle', 26 * HOUR],
        ['g2', 'lab', 'claude', 'idle', 7 * 24 * HOUR],
      ],
    ),
  ]
}

/**
 * 示例里的题目 → 界面看到的题目。allowOther：有选项的题能不能另外自己填；没有选项的题总是自己填
 */
export const sampleQuestions = (list: SampleQuestion[], allowOther: boolean): QuestionView[] =>
  list.map((question, index) => ({
    id: `q${index + 1}`,
    header: question.header,
    question: question.question,
    options: question.options,
    allowOther: allowOther || !question.options,
    secret: false,
  }))

/** s1 这个会话里还没“说完”的回答。模拟核心会把它一小段一小段地流出来 */
/** 发消息时能选什么。最后一个模型没有强度档，用来看强度控件会不会跟着消失 */
export const SAMPLE_OPTIONS: ComposeOptions = {
  models: [
    {
      id: 'claude-sonnet-5-5',
      title: 'Sonnet 5.5',
      efforts: ['low', 'medium', 'high'].map((id) => ({ id, note: '' })),
      defaultEffort: 'medium',
      speeds: [],
      defaultSpeed: null,
      isDefault: true,
      acceptsImages: true,
    },
    {
      id: 'claude-opus-5-5',
      title: 'Opus 5.5',
      efforts: ['low', 'medium', 'high', 'xhigh'].map((id) => ({ id, note: '' })),
      defaultEffort: 'high',
      speeds: [],
      defaultSpeed: null,
      isDefault: false,
      acceptsImages: true,
    },
    {
      id: 'claude-haiku-5-5',
      title: 'Haiku 5.5',
      efforts: [],
      defaultEffort: null,
      speeds: [],
      defaultSpeed: null,
      isDefault: false,
      acceptsImages: true,
    },
  ],
  permissions: [...BUILTIN_PERMISSIONS],
  plan: true,
}

/** 各个 harness 的模型清单。权限预设不在这里：那要看它在这台设备上有没有声明（见 sampleOptions） */
type ModelList = Pick<ComposeOptions, 'models'>

/** 原生 codex 的快速档（真的 model/list 里就是这样：标识 priority，名字 Fast） */
const FAST = { id: 'priority', title: 'Fast', note: '1.5x speed, increased usage' }

const sampleModel = (
  id: string,
  title: string,
  efforts: string[],
  isDefault = false,
  speed: { defaultSpeed: string | null } | null = null,
): ComposeOptions['models'][number] => ({
  id,
  title,
  efforts: efforts.map((effort) => ({ id: effort, note: '' })),
  defaultEffort: efforts.includes('medium') ? 'medium' : (efforts[0] ?? null),
  speeds: speed ? [FAST] : [],
  defaultSpeed: speed?.defaultSpeed ?? null,
  isDefault,
  acceptsImages: true,
})

/**
 * 别的 harness 各有各的模型清单。一台设备上有几个 harness 时，底栏的清单要按会话所属的那个来取：
 * 这几份故意互不相同，在界面上看得出取的是哪一份。没列在这里的（Claude Code）用上面那一份
 */
const OTHER_OPTIONS: Record<string, ModelList> = {
  pi: {
    models: [
      sampleModel('gate/large', 'Gate Large', ['low', 'medium', 'high'], true),
      sampleModel('gate/small', 'Gate Small', []),
    ],
  },
  dsh: {
    models: [sampleModel('deepseek-chat', 'DeepSeek Chat', [], true)],
  },
  // codex 的清单长：选择器顶上会出筛选框（选项 8 个起才出）。前三个能换速度，
  // 其中 GPT-5.5 默认就是快速（真的 model/list 里有这样的模型），mini 没有速度可选
  codex: {
    models: [
      sampleModel('gpt-5.5-codex', 'GPT-5.5 Codex', ['low', 'medium', 'high'], true, {
        defaultSpeed: null,
      }),
      sampleModel('gpt-5.5-mini', 'GPT-5.5 mini', ['low', 'medium']),
      sampleModel('gpt-5.5', 'GPT-5.5', ['low', 'medium', 'high'], false, {
        defaultSpeed: 'priority',
      }),
      sampleModel('gpt-5.4-codex', 'GPT-5.4 Codex', ['low', 'medium', 'high']),
      sampleModel('gpt-5.4', 'GPT-5.4', ['low', 'medium', 'high']),
      sampleModel('gpt-5.4-mini', 'GPT-5.4 mini', ['low', 'medium']),
      sampleModel('o5', 'o5', ['medium', 'high']),
      sampleModel('o5-mini', 'o5 mini', ['medium']),
      sampleModel('gpt-5.3-codex', 'GPT-5.3 Codex', ['low', 'medium', 'high']),
    ],
  },
}

/**
 * 在某个 harness 上发消息时能选什么。权限预设：它有声明就用它声明的那几档（标题和说明是它给的），
 * 没有声明用内置的三档
 */
export function sampleOptions(harness: HarnessView | undefined): ComposeOptions {
  const models = (OTHER_OPTIONS[harness?.id ?? ''] ?? SAMPLE_OPTIONS).models
  return {
    models,
    permissions: samplePresets(harness) ?? [...BUILTIN_PERMISSIONS],
    // dsh 不会计划模式（真的 dsh 的协作模式清单里也只有一种）
    plan: harness?.id !== 'dsh',
  }
}

/**
 * 某个 harness 上的会话一开始用的设置：它的默认模型和那个模型默认的强度。
 * 原生 codex 照真的来：配置里没写强度、也没人选过时，它报的强度是 null（用模型自己的默认档，
 * 见 projection/settings.mts 的 shownEffort），底栏要显示成默认的那一档
 */
export function sampleSettings(harness: HarnessView | undefined): SessionSettings {
  const { models, permissions, plan } = sampleOptions(harness)
  const model = models.find((entry) => entry.isDefault) ?? models[0]
  const preset: PermissionPreset | undefined =
    permissions.find((entry) => entry.id === ':workspace') ?? permissions[0]
  return {
    model: model?.id ?? null,
    effort: harness?.id === 'codex' ? null : (model?.defaultEffort ?? null),
    speed: null,
    permission: preset?.id ?? null,
    mode: plan ? 'default' : null,
  }
}

/** 不带设置新建会话时用的：就是 sampleSettings 里那几项（模拟的新会话一开始就是它） */
export function sampleDefaults(harness: HarnessView | undefined): SessionDefaults {
  const { model, effort, speed, permission } = sampleSettings(harness)
  return { model, effort, speed, permission }
}

export const STREAM_SESSION = {
  deviceId: 'local',
  sessionId: 's1',
  turnId: 's1-t2',
  itemId: 's1-t2-a2',
}
/** 这段回答一开始就有的那一句，和之后一小段一小段流出来的部分 */
export const streamText = (lang: SampleLang): { head: string; rest: string } => ({
  head: SAMPLE_TEXT[lang].streamHead,
  rest: SAMPLE_TEXT[lang].streamRest,
})

const SERVE_DIFF = `@@ -128,6 +128,8 @@ func (c configuration) serveRuntime() error {
 \tlistener, err := sshserver.Listen(c.port)
-\tif err != nil { return listenFailure(c.port, err) }
-\treturn serve(listener)
+\tif err != nil {
+\t\tentry.fail(err)
+\t\treturn nil
+\t}
 }
`

const SERVE_TEST_DIFF = `@@ -0,0 +1,6 @@
+func TestEntryFailureKeepsRuntime(t *testing.T) {
+\tbusy := occupy(t, 7332)
+\tdefer busy.Close()
+\tstate := start(t, "--harness", "pi")
+\tassertEntryFailed(t, state, "ssh")
+}
`

export function sampleSession(
  summary: SessionSummary,
  deviceId: string,
  now: number,
  lang: SampleLang,
  /** 它所属的那个 harness（设备上现在声明的样子）。设置、审批能不能附说明都看它 */
  harness?: HarnessView,
): SessionView {
  const text = SAMPLE_TEXT[lang]
  const turns: TurnView[] = []
  const items: Record<string, ItemView> = {}
  const requests: RequestView[] = []
  const add = (turn: TurnView, list: ItemView[]) => {
    for (const item of list) {
      items[item.id] = item
      turn.itemIds.push(item.id)
    }
    turns.push(turn)
  }
  const id = summary.id

  if (id === STREAM_SESSION.sessionId && deviceId === STREAM_SESSION.deviceId) {
    // 更早的几轮问答，只为了让这个会话够长，能滚起来
    text.history.forEach(([question, answer], index) => {
      const turnId = `s1-h${index}`
      add(
        {
          id: turnId,
          status: 'completed',
          itemIds: [],
          startedAt: now - (40 - index * 3) * MINUTE,
          durationMs: 6000 + index * 900,
          error: null,
        },
        [
          { id: `${turnId}-u`, kind: 'userMessage', text: question, attachments: [] },
          {
            id: `${turnId}-a`,
            kind: 'agentMessage',
            phase: 'final',
            status: 'completed',
            text: answer,
          },
        ],
      )
    })
    add(
      {
        id: 's1-t1',
        status: 'completed',
        itemIds: [],
        startedAt: now - 9 * MINUTE,
        durationMs: 41_000,
        error: null,
      },
      [
        {
          id: 's1-t1-u',
          kind: 'userMessage',
          text: text.firstAsk,
          attachments: [],
        },
        {
          id: 's1-t1-c',
          kind: 'command',
          command: 'grep -n "listenFailure" cmd/codex-harness-adapter/serve.go',
          cwd: summary.cwd,
          output: '131:\tif err != nil { return listenFailure(c.port, err) }\n',
          elided: null,
          exitCode: 0,
          durationMs: 180,
          startedAt: null,
          status: 'completed',
        },
        {
          id: 's1-t1-a',
          kind: 'agentMessage',
          phase: 'final',
          status: 'completed',
          text: text.firstAnswer,
        },
      ],
    )
    add(
      {
        id: STREAM_SESSION.turnId,
        status: 'running',
        itemIds: [],
        startedAt: now - 2 * MINUTE,
        durationMs: null,
        error: null,
      },
      [
        {
          id: 's1-t2-u',
          kind: 'userMessage',
          text: text.secondAsk,
          attachments: [],
        },
        {
          id: 's1-t2-r',
          kind: 'reasoning',
          status: 'completed',
          text: text.secondThought,
        },
        {
          id: 's1-t2-f',
          kind: 'fileChange',
          status: 'completed',
          changes: [
            {
              path: 'cmd/codex-harness-adapter/serve.go',
              change: 'update',
              movedTo: null,
              added: 4,
              removed: 2,
              diff: SERVE_DIFF,
              diffKind: 'patch',
              elided: null,
            },
            {
              path: 'cmd/codex-harness-adapter/serve_test.go',
              change: 'add',
              movedTo: null,
              added: 6,
              removed: 0,
              diff: SERVE_TEST_DIFF,
              diffKind: 'patch',
              elided: null,
            },
          ],
        },
        {
          id: 's1-t2-c',
          kind: 'command',
          command: 'go test ./cmd/... ./sshserver/...',
          cwd: summary.cwd,
          output:
            'ok  \tcodex-harness-adapter/sshserver\t1.204s\nok  \tcodex-harness-adapter/cmd/codex-harness-adapter\t2.118s\n',
          elided: null,
          exitCode: 0,
          durationMs: 3400,
          startedAt: null,
          status: 'completed',
        },
        {
          id: STREAM_SESSION.itemId,
          kind: 'agentMessage',
          phase: 'unknown',
          status: 'inProgress',
          text: text.streamHead,
        },
      ],
    )
  } else if (summary.status === 'waiting') {
    // 停下来等人的两个会话：一个等审批，一个等回答
    const approval = summary.waitingFor === 'approval'
    const command =
      'npm install --save-dev fast-check@4.3.0 && npm test -- --grep "composite cursor"'
    add(
      {
        id: `${id}-t1`,
        status: 'running',
        itemIds: [],
        startedAt: summary.updatedAt - MINUTE,
        durationMs: null,
        error: null,
      },
      [
        {
          id: `${id}-t1-u`,
          kind: 'userMessage',
          text: approval ? text.approvalAsk : text.questionAsk,
          attachments: [],
        },
        {
          id: `${id}-t1-a`,
          kind: 'agentMessage',
          phase: 'commentary',
          status: 'completed',
          text: approval ? text.approvalNote : text.questionNote,
        },
        ...(approval
          ? [
              {
                id: `${id}-t1-c`,
                kind: 'command',
                command,
                cwd: summary.cwd,
                output: '',
                elided: null,
                exitCode: null,
                durationMs: null,
                startedAt: null,
                status: 'inProgress',
              } satisfies ItemView,
            ]
          : []),
      ],
    )
    requests.push(
      approval
        ? {
            id: `${id}-r1`,
            kind: 'approval',
            subject: 'command',
            itemId: `${id}-t1-c`,
            command,
            cwd: summary.cwd,
            reason: text.approvalReason,
            permissions: null,
            tool: null,
            options: [
              { id: 'accept', role: 'accept' },
              { id: 'acceptSession', role: 'acceptSession' },
              // 这一条的“拒绝”可以附一句说明：它所属的 harness 声明了认识这项扩展才有
              { id: 'decline', role: 'decline', ...(takesNote(harness) ? { note: true } : {}) },
              { id: 'cancel', role: 'cancel' },
            ],
          }
        : {
            id: `${id}-r1`,
            kind: 'question',
            itemId: null,
            questions: sampleQuestions(text.questions, true),
          },
      // 后面各排着一个 MCP 服务来的请求：工具调用的审批，和一张要填的表
      approval
        ? {
            id: `${id}-r2`,
            kind: 'approval',
            subject: 'tool',
            itemId: null,
            command: null,
            cwd: null,
            reason: text.toolAsk.reason,
            permissions: null,
            tool: {
              server: 'tracker',
              title: text.toolAsk.title,
              note: text.toolAsk.note,
              params: JSON.stringify({ title: text.toolAsk.ticket, labels: ['bug'] }, null, 2),
            },
            options: [
              { id: 'accept', role: 'accept' },
              { id: 'acceptSession', role: 'acceptSession' },
              { id: 'acceptAlways', role: 'acceptAlways' },
              { id: 'decline', role: 'decline' },
              { id: 'cancel', role: 'cancel' },
            ],
          }
        : {
            id: `${id}-r2`,
            kind: 'form',
            itemId: null,
            server: 'deploy',
            message: text.form.message,
            link: null,
            fields: [
              {
                ...FIELD,
                id: 'region',
                label: text.form.region,
                required: true,
                kind: 'choice',
                options: [
                  { value: 'ap-east', label: text.form.regions[0] },
                  { value: 'us-west', label: text.form.regions[1] },
                ],
              },
              {
                ...FIELD,
                id: 'replicas',
                label: text.form.replicas,
                required: true,
                kind: 'integer',
                initial: 2,
                // 定了范围的一栏：填出界的数，界面当场说，不发
                limits: { ...FIELD.limits, min: 1, max: 20 },
              },
              {
                ...FIELD,
                id: 'notify',
                label: text.form.notify,
                note: text.form.notifyNote,
                format: 'email',
              },
              {
                ...FIELD,
                id: 'migrate',
                label: text.form.migrate,
                kind: 'boolean',
                initial: false,
              },
              {
                ...FIELD,
                id: 'checks',
                label: text.form.checks,
                kind: 'choices',
                options: ['smoke', 'e2e', 'perf'].map((value, index) => ({
                  value,
                  label: text.form.checkNames[index] ?? value,
                })),
                initial: ['smoke'],
              },
            ],
          },
    )
  } else {
    add(
      {
        id: `${id}-t1`,
        status: summary.status === 'error' ? 'failed' : 'completed',
        itemIds: [],
        startedAt: summary.updatedAt - MINUTE,
        durationMs: 32_000,
        error: summary.status === 'error' ? text.diskFull : null,
      },
      [
        { id: `${id}-t1-u`, kind: 'userMessage', text: text.titles[id] ?? id, attachments: [] },
        {
          id: `${id}-t1-a`,
          kind: 'agentMessage',
          phase: 'final',
          status: 'completed',
          text: text.placeholder,
        },
      ],
    )
  }

  return {
    deviceId,
    sessionId: id,
    title: summary.title,
    harness: summary.harness,
    cwd: summary.cwd,
    live: true,
    note: null,
    turns,
    items,
    requests,
    queued: [],
    settings: sampleSettings(harness),
    // 有内容的会话给一个占用，回合越多占得越多；空会话没有
    usage: turns.length
      ? { usedTokens: 18_400 + turns.length * 6_650, windowTokens: 200_000 }
      : null,
    can: { ...ALL_ABLE },
    forkedFrom: null,
    proposals: [],
    agents: [],
  }
}
