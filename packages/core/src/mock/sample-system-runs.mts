// 示例会话 d7 的历史：像经理那样被系统消息一次次叫醒（子会话回报、别的会话发来的消息、后台任务结束），
// 中间夹着用户自己的话和模型写给用户的正文。用来看跨回合收起块（projection/system-fold.mts）：
// 连续的系统回合并成一块，用户的话和正文把块切开。
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
  merged: string
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
    merged: '入口和运行时两条已合入，CI 全绿；设备那条还在做。',
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
    merged: 'Entry and runtime are merged with green CI; device is still in progress.',
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
  const read = (id: string, ms: number): ItemView => ({
    id,
    kind: 'toolCall',
    source: 'litch_sessions',
    tool: 'read',
    input: [{ kind: 'text', text: '{"turns":2}' }],
    output: [{ kind: 'text', text: copy.excerpt }],
    error: null,
    durationMs: ms,
    status: 'completed',
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
  const answer = (id: string, text: string): ItemView => ({
    id,
    kind: 'agentMessage',
    phase: 'unknown',
    status: 'completed',
    text,
  })
  return [
    [turn('d7-u1', 21_000), [user('d7-u1-u', copy.ask), answer('d7-u1-a', copy.dispatched)]],
    // 两条回报，模型看完没说话：并成一块
    [turn('d7-r1', 1_200), [report('d7-r1-u', [0]), read('d7-r1-c1', 40)]],
    [
      turn('d7-r2', 3_400),
      [report('d7-r2-u', [1]), read('d7-r2-c1', 38), command('d7-r2-c2', 'git log -1', 210)],
    ],
    // 别的会话发来消息，模型写了正文：消息和过程并进前面那块，正文露在外面
    [
      turn('d7-p1', 6_800, { origin: 'peer' }),
      [
        {
          id: 'd7-p1-u',
          kind: 'userMessage',
          text: copy.peerText,
          attachments: [],
          peer: { name: copy.peer, session: null, bypass: false },
        },
        read('d7-p1-c1', 52),
        answer('d7-p1-a', copy.merged),
      ],
    ],
    // 正文之后的系统回合另起一块：后台任务结束、又一条回报
    [
      turn('d7-b1', 9_500, { origin: 'backgroundTask' }),
      [command('d7-b1-c1', 'npm run client:test', 8_900)],
    ],
    [turn('d7-r3', 2_100), [report('d7-r3-u', [2]), read('d7-r3-c1', 45)]],
    // 用户自己的话把块切开
    [
      turn('d7-u2', 4_300),
      [
        user('d7-u2-u', copy.progress),
        read('d7-u2-c1', 41),
        answer('d7-u2-a', copy.progressAnswer),
      ],
    ],
    [
      turn('d7-r4', 5_600),
      [report('d7-r4-u', [2]), read('d7-r4-c1', 47), answer('d7-r4-a', copy.lastAnswer)],
    ],
  ]
}
