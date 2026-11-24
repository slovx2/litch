// 示例会话 d7 的历史：像 Claude 上的经理那样被系统消息一次次叫醒（子会话回报、别的会话发来的消息、看板答复、
// 后台任务结束），每个事件回合的形状照真实经理会话：消息 → 读会话、发消息几个工具 →（有时）中途一段话 →
// 再几个工具 → 空收尾 → 结尾一句话。内容是虚构的。中间夹着用户自己的一句话。
// 用来看跨回合收起块（projection/system-fold.mts）：连续的系统回合并成一块，只露整串最后那段结尾文字。
import type { ItemView, TurnView } from '../model.mjs'
import type { SampleLang } from './sample-text.mjs'

export const SYSTEM_RUNS_SESSION = { deviceId: 'local', sessionId: 'd7' }

const MINUTE = 60_000

interface Copy {
  ask: string
  dispatched: string
  lines: [string, string, string]
  excerpt: string
  peer: string
  peerText: string
  /** 每个事件回合结尾那一句 */
  ends: [string, string, string, string, string]
  /** 中途那一段 */
  mid: string
  progress: string
  progressAnswer: string
  lastAnswer: string
}

const COPY: Record<SampleLang, Copy> = {
  'zh-CN': {
    ask: '把术语表拆成三条线做：入口、运行时、设备，做完回报给我',
    dispatched: '已派出三条线，各自做完会回报。',
    lines: ['术语表：入口', '术语表：运行时', '术语表：设备'],
    excerpt: '做完了，改动在分支上，检查都通过。',
    peer: '集成长线',
    peerText: '入口和运行时两条已经合进 main，CI 全绿。',
    ends: [
      '入口那条做完了，已交给集成线合并。',
      '运行时那条也做完了，同样交给集成线。',
      '收到，入口和运行时已合入；设备那条还在做。',
      '看板上的答复已转给设备那条线。',
      '后台测试跑完，全部通过。',
    ],
    mid: '先确认一下设备那条的分支状态。',
    progress: '设备那条怎么样了？',
    progressAnswer: '设备那条已经回报完成，测试也补上了，正在等集成线合并。',
    lastAnswer: '三条线都合进 main 了，术语表这件事做完了。',
  },
  en: {
    ask: 'Split the glossary into three lines: entry, runtime, device. Report back when done.',
    dispatched: 'Three lines are running; each will report back when done.',
    lines: ['Glossary: entry', 'Glossary: runtime', 'Glossary: device'],
    excerpt: 'Done. The change is on its branch and all checks pass.',
    peer: 'Integration line',
    peerText: 'Entry and runtime are merged into main, CI is green.',
    ends: [
      'Entry is done and handed to integration.',
      'Runtime is done too and handed to integration.',
      'Got it: entry and runtime are merged; device is still in progress.',
      'Forwarded your board answer to the device line.',
      'The background tests finished and all pass.',
    ],
    mid: 'Checking the device line branch first.',
    progress: 'How is the device line doing?',
    progressAnswer:
      'The device line reported done with tests added; it is waiting for integration.',
    lastAnswer: 'All three lines are in main. The glossary work is done.',
  },
}

/** 这个会话的回合和条目，按先后 */
export function systemRunsHistory(
  lang: SampleLang,
  cwd: string,
  now: number,
): [turn: TurnView, items: ItemView[]][] {
  const copy = COPY[lang]
  let clock = now - 50 * MINUTE
  const turn = (id: string, durationMs: number, extra: Partial<TurnView> = {}): TurnView => {
    clock += 4 * MINUTE
    return {
      id,
      status: 'completed',
      itemIds: [],
      startedAt: clock,
      durationMs,
      error: null,
      ...extra,
    }
  }
  const user = (id: string, text: string): ItemView => ({
    id,
    kind: 'userMessage',
    text,
    attachments: [],
  })
  const report = (id: string, lines: number[]): ItemView => ({
    id,
    kind: 'userMessage',
    text: '',
    attachments: [],
    event: {
      kind: 'notes',
      notes: lines.map((line) => ({
        threadId: `d7-line-${line}`,
        title: copy.lines[line] ?? '',
        status: 'completed',
        excerpt: copy.excerpt,
      })),
    },
  })
  const sessions = (id: string, tool: string, ms: number): ItemView => ({
    id,
    kind: 'toolCall',
    source: 'litch_sessions',
    tool,
    input: [{ kind: 'text', text: '{}' }],
    output: [{ kind: 'text', text: copy.excerpt }],
    error: null,
    durationMs: ms,
    status: 'completed',
  })
  const wrapUp = (id: string): ItemView => ({
    ...(sessions(id, 'wrap_up', 6) as ItemView & { kind: 'toolCall' }),
    wrapUp: { suggestions: [] },
  })
  const command = (id: string, line: string, ms: number): ItemView => ({
    id,
    kind: 'command',
    command: line,
    cwd,
    output: 'ok\n',
    elided: null,
    exitCode: 0,
    durationMs: ms,
    startedAt: null,
    status: 'completed',
  })
  // Claude 入口分不清阶段，文字一律是 unknown
  const say = (id: string, text: string): ItemView => ({
    id,
    kind: 'agentMessage',
    phase: 'unknown',
    status: 'completed',
    text,
  })
  /** 一个事件回合：开场消息 → 读会话 →（中途一段话 → 派线）→ 发消息 → 空收尾 → 结尾一句 */
  const event = (id: string, opener: ItemView, end: string, mid = false): ItemView[] => [
    opener,
    sessions(`${id}-read`, 'read', 40),
    ...(mid ? [say(`${id}-mid`, copy.mid), sessions(`${id}-list`, 'list', 35)] : []),
    sessions(`${id}-send`, 'send', 52),
    wrapUp(`${id}-wrap`),
    say(`${id}-end`, end),
  ]
  return [
    [turn('d7-u1', 21_000), [user('d7-u1-u', copy.ask), say('d7-u1-a', copy.dispatched)]],
    // 五个连着的事件回合，每个结尾都写一句：并成一块，只露最后一句
    [turn('d7-r1', 3_200), event('d7-r1', report('d7-r1-u', [0]), copy.ends[0])],
    [turn('d7-r2', 3_400), event('d7-r2', report('d7-r2-u', [1]), copy.ends[1])],
    [
      turn('d7-p1', 6_800, { origin: 'peer' }),
      event(
        'd7-p1',
        {
          id: 'd7-p1-u',
          kind: 'userMessage',
          text: copy.peerText,
          attachments: [],
          peer: { name: copy.peer, session: null, bypass: false },
        },
        copy.ends[2],
        true,
      ),
    ],
    [
      turn('d7-a1', 4_100),
      event(
        'd7-a1',
        {
          id: 'd7-a1-u',
          kind: 'userMessage',
          text: '',
          attachments: [],
          event: { kind: 'manager-answers', notes: [], summary: 'D-12' },
        },
        copy.ends[3],
      ),
    ],
    [
      turn('d7-b1', 9_500, { origin: 'backgroundTask' }),
      [command('d7-b1-c1', 'npm run client:test', 8_900), say('d7-b1-a', copy.ends[4])],
    ],
    // 用户自己的话把块切开
    [
      turn('d7-u2', 4_300),
      [
        user('d7-u2-u', copy.progress),
        sessions('d7-u2-c1', 'read', 41),
        say('d7-u2-a', copy.progressAnswer),
      ],
    ],
    [turn('d7-r3', 5_600), event('d7-r3', report('d7-r3-u', [2]), copy.lastAnswer)],
  ]
}
