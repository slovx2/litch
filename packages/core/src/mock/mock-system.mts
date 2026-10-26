// 模拟核心里 Litch 替用户发的话（protocol/src/system-messages.mts）：对话里说“系统消息”（英文 system messages），
// 先回一句，再接着摆出几轮由 Litch 发起的回合，每轮开头是一种系统消息，看卡片的样子：
// 定时任务触发（来历 schedule）、新会话的简报（带背景）、交接的计划、提案卡上的“在这里做”（前面攒着一条回报）、
// 别的会话用 litch_sessions.send 发来的一句。条目从原文经真的投影出来，认不认得出和真的一样。
import { formatSessionEvent, type ThreadItem } from '../../../protocol/src/index.mjs'
import type { SessionOp } from '../channel/protocol.mjs'
import type { OutgoingMessage, SessionView } from '../model.mjs'
import { projectItem } from '../projection/items.mjs'
import type { SampleLang } from './sample-text.mjs'

const STARTS = /系统消息|system messages/i

const CLOSING =
  'When you are done, end your turn with a short summary of the result and anything left open: Litch passes the beginning of your final answer back to the session that started you. If you need a decision, ask the user here; that session cannot answer for them.'

const TEXT = {
  'zh-CN': {
    intro: '下面几轮是 Litch 替你发起的，开头那条画成卡片，点“展开全文”看发给模型的原文。',
    task: '整理日报',
    taskPrompt:
      '把今天合进 main 的提交按仓库整理成日报：每个仓库一段，先写改了什么、再写还没做完的。\n没有提交的仓库不写。',
    parent: '主会话：发版前检查',
    title: '查构建为什么变慢',
    background: '这一轮在给 CI 提速，用户最在意门禁的墙钟时间。上周的基线是 14 分钟。',
    prompt:
      '找出 ci.yml 里最慢的三步，各说一句为什么慢、能不能并行或缓存。\n只读不改；结论写在最后的回答里。',
    plan: '1. 补完侧栏标题的样式\n2. 跑 npm run check\n3. 在预览里看一遍复古皮肤',
    here: '在这里做：',
    hereTitle: '去掉复古皮肤的标题前缀',
    herePrompt: '侧栏分区、分组标题前面的 “## ” 去掉，其他皮肤不变。',
    child: '查构建为什么变慢',
    excerpt: '最慢的是端到端用例，占 9 分钟。',
    from: '修 CI',
    message: '我这边改完了 ci.yml 的缓存键，你那边的基线能再跑一次吗？跑完把墙钟时间告诉我。',
    reply: '收到。',
  },
  en: {
    intro:
      'The next few turns were started by Litch for you; the first message of each is a card. Click Show full text to see what the model got.',
    task: 'Daily report',
    taskPrompt:
      'Summarize the commits merged into main today, one paragraph per repository: what changed, then what is still open.\nSkip repositories with no commits.',
    parent: 'Main: release checks',
    title: 'Find why the build got slower',
    background:
      'This round speeds up CI; the user cares most about the gate wall-clock time. Last week the baseline was 14 minutes.',
    prompt:
      'Find the three slowest steps in ci.yml and say for each why it is slow and whether it can run in parallel or be cached.\nRead only; put the findings in your final answer.',
    plan: '1. Finish the sidebar heading styles\n2. Run npm run check\n3. Check the retro skin in the preview',
    here: 'Do it here: ',
    hereTitle: 'Drop the retro heading prefix',
    herePrompt:
      'Remove the “## ” before sidebar section and group headings; other skins stay as they are.',
    child: 'Find why the build got slower',
    excerpt: 'The end-to-end tests are the slowest, 9 minutes.',
    from: 'Fix CI',
    message:
      'I changed the cache key in ci.yml. Can you run the baseline again and tell me the wall-clock time?',
    reply: 'Got it.',
  },
} as const

export interface MockSystemHost {
  lang: SampleLang
  now(): number
  /** 在回合里流出一段回答，流完先应用 tail 给的那几步、再结束回合 */
  reply(view: SessionView, turnId: string, text: string, tail?: () => SessionOp[]): void
  nextId(prefix: string): string
}

export interface MockSystem {
  /** 这条消息是不是要看系统消息：是的话由这里接着演，返回 true */
  claim(view: SessionView, turnId: string, message: OutgoingMessage): boolean
}

export function createMockSystem(host: MockSystemHost): MockSystem {
  const text = TEXT[host.lang]
  const parentId = 'thread-main-7'
  const briefing = [
    `[Litch] Another session on this device started this one: "${text.parent}" (${parentId}, claude-code). You cannot see that conversation; the user can open this session and talk to you directly.`,
    '',
    `Background:\n${text.background}`,
    '',
    `Task: ${text.title}`,
    '',
    text.prompt,
    '',
    CLOSING,
  ].join('\n')
  const handOff = [
    `[Litch] You are taking over a task that "${text.parent}" (${parentId}, claude-code) was in the middle of: a new, unrelated user message arrived there, so it handed this task to you and went on to answer that message. You have the conversation above, up to the turn before that message; finish the task here as a separate sub-session.`,
    '',
    `Task: ${text.hereTitle}`,
    '',
    `Remaining plan:\n${text.plan}`,
    '',
    CLOSING,
  ].join('\n')
  const task = [
    '[Scheduled task run]',
    'This message was sent automatically by a scheduled task on this device, not typed by a person just now.',
    `Task: ${text.task}`,
    'Trigger: schedule',
    'Scheduled for: 2026-10-26 18:00 (Asia/Shanghai)',
    'Current time: 2026-10-26 18:00 (Asia/Shanghai)',
    'No one is watching this run. Work on your own and finish as much as you can without waiting for answers; if something needs a person, say clearly what is left.',
    'The task instructions follow.',
    '---',
    text.taskPrompt,
  ].join('\n')
  const here = `${formatSessionEvent({
    kind: 'notes',
    notes: [
      { threadId: 'thread-child-3', title: text.child, status: 'completed', excerpt: text.excerpt },
    ],
  })}${text.here}${text.hereTitle}\n\n${text.herePrompt}`
  const send = `[Litch] Message from session "${text.from}" (${parentId}), not typed by the user:\n\n${text.message}`

  /** 一轮由 Litch 发起的回合：开头是那条原文，跟一句回答 */
  const turn = (raw: string, origin?: 'schedule'): SessionOp[] => {
    const turnId = host.nextId('sys')
    const user = projectItem({
      type: 'userMessage',
      id: host.nextId('sys-u-'),
      content: [{ type: 'text', text: raw, text_elements: [] }],
    } as unknown as ThreadItem)
    const answer = {
      id: `${turnId}:${host.nextId('sys-a-')}`,
      kind: 'agentMessage' as const,
      phase: 'final' as const,
      status: 'completed' as const,
      text: text.reply,
    }
    return [
      {
        op: 'turn.add',
        turn: {
          id: turnId,
          status: 'completed',
          itemIds: [],
          startedAt: host.now(),
          durationMs: 2400,
          error: null,
          ...(origin ? { origin } : {}),
        },
      },
      { op: 'item.add', turnId, item: { ...user, id: `${turnId}:${user.id}` } },
      { op: 'item.add', turnId, item: answer },
    ]
  }

  return {
    claim(view, turnId, message) {
      if (!STARTS.test(message.text)) return false
      // 回答流完再摆出后面几轮，排在这一轮后面
      host.reply(view, turnId, text.intro, () => [
        ...turn(task, 'schedule'),
        ...turn(briefing),
        ...turn(handOff),
        ...turn(here),
        ...turn(send),
      ])
      return true
    },
  }
}
