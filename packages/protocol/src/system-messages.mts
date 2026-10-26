// Litch 自己替用户发进会话的话：对话里认回来，画成卡片（一行来源和类型、一两行简略内容、点开看全文），不画成用户亲手打的。
// 拼法在设备进程那边（定时任务 task-run.mts 的 taskPrompt、子会话的简报 session-start.mts 的 briefing、
// 发给别的会话 session-tools.mts 的 send、提案卡上“在这里做” session-tree.mts 的 proposalHere），
// 这里只认文字本身：原生 CLI 起的会话、导入的历史也一样认得出。两边对不上由设备包里的往返单测守着。
// 认不出的（格式坏了、用户自己恰好这样打）整条照常当用户的话。不依赖别的文件

/** 定时任务触发的回合开头那条 */
export interface ScheduledTaskMessage {
  kind: 'scheduledTask'
  /** 任务名 */
  task: string
  /** 手动“立即运行”的（不是按日程） */
  manual: boolean
  /** 任务的提示词（分隔线后面那段） */
  prompt: string
}

/** 子会话启动时设备进程发给它的简报：新会话、分叉、交接 */
export interface BriefingMessage {
  kind: 'briefing'
  mode: 'fresh' | 'fork' | 'handOff'
  /** 派出它的会话。标题是空的时简报里写的是会话号，这里是空串 */
  parent: { id: string; harness: string; title: string }
  /** 任务的标题 */
  title: string
  /** 背景（只有新会话带） */
  background: string
  /** 任务原文；交接的是剩下的计划 */
  prompt: string
}

/** 提案卡上点了“在这里做”：标题加任务原文，前面一句引导语 */
export interface HereMessage {
  kind: 'here'
  title: string
  prompt: string
}

export type SystemMessage = ScheduledTaskMessage | BriefingMessage | HereMessage

/** 别的会话用 litch_sessions.send 发来的一句 */
export interface SessionMessage {
  /** 发来的会话：会话号，标题（没有标题是 null） */
  from: { id: string; title: string | null }
  /** 对方的原话（去掉了开头的来源和末尾教模型怎么回话的那句） */
  message: string
}

const SCHEDULED_HEAD = '[Scheduled task run]\n'
/** 引导语：界面按语言给的（ui、手机端的 proposal.here.lead），设备进程缺省的是英文那句 */
export const HERE_LEADS = ['Do it here: ', '在这里做：'] as const

/** 父会话那一段：`"标题或会话号" (会话号, harness)` */
const WHO = '"(.*)" \\(([^\\s,()]+), ([^\\s,()]+)\\)'
const BRIEFING_HEADS: [BriefingMessage['mode'], RegExp][] = [
  [
    'handOff',
    new RegExp(`^\\[Litch\\] You are taking over a task that ${WHO} was in the middle of: `),
  ],
  [
    'fork',
    new RegExp(`^\\[Litch\\] This session is a fork of ${WHO}: you have that conversation above`),
  ],
  ['fresh', new RegExp(`^\\[Litch\\] Another session on this device started this one: ${WHO}\\. `)],
]
const BRIEFING_CLOSING = '\n\nWhen you are done, end your turn with a short summary'

const SESSION_MESSAGE =
  /^\[Litch\] Message from session (?:"(.*)" )?\(([^\s()]+)\), not typed by the user:\n\n/
const SESSION_MESSAGE_REPLY =
  /\n\n\(To answer, send a message back with litch_sessions\.send to thread_id [^\s;]+; your reply in this conversation does not reach that session\.\)$/

function scheduledTask(text: string): ScheduledTaskMessage | null {
  if (!text.startsWith(SCHEDULED_HEAD)) return null
  const split = text.indexOf('\n---\n')
  if (split < 0) return null
  const head = text.slice(0, split)
  const task = /^Task: (.*)$/m.exec(head)?.[1]
  if (task === undefined) return null
  return {
    kind: 'scheduledTask',
    task,
    manual: /^Trigger: run now/m.test(head),
    prompt: text.slice(split + 5),
  }
}

function briefing(text: string): BriefingMessage | null {
  const newline = text.indexOf('\n\n')
  if (newline < 0) return null
  const first = text.slice(0, newline)
  for (const [mode, pattern] of BRIEFING_HEADS) {
    const match = pattern.exec(first)
    if (!match) continue
    const [, shown = '', id = '', harness = ''] = match
    let body = text.slice(newline + 2)
    const closing = body.lastIndexOf(BRIEFING_CLOSING)
    if (closing >= 0) body = body.slice(0, closing)
    let background = ''
    if (body.startsWith('Background:\n')) {
      const end = body.indexOf('\n\nTask: ')
      if (end < 0) return null
      background = body.slice('Background:\n'.length, end)
      body = body.slice(end + 2)
    }
    const task = /^Task: (.*)\n\n/.exec(body)
    if (!task) return null
    const rest = body.slice(task[0].length)
    const prompt =
      mode === 'handOff' && rest.startsWith('Remaining plan:\n')
        ? rest.slice('Remaining plan:\n'.length)
        : rest
    return {
      kind: 'briefing',
      mode,
      parent: { id, harness, title: shown === id ? '' : shown },
      title: task[1] ?? '',
      background,
      prompt,
    }
  }
  return null
}

function here(text: string): HereMessage | null {
  const lead = HERE_LEADS.find((each) => text.startsWith(each))
  if (!lead) return null
  const match = /^([^\n]+)\n\n([\s\S]+)$/.exec(text.slice(lead.length))
  if (!match) return null
  return { kind: 'here', title: match[1] ?? '', prompt: match[2] ?? '' }
}

/** 这条用户消息是不是 Litch 替用户发的（定时任务、子会话的简报、在这里做）。不是的返回 null */
export function parseSystemMessage(text: string): SystemMessage | null {
  return scheduledTask(text) ?? briefing(text) ?? here(text)
}

/** 这条用户消息是不是别的会话用 litch_sessions.send 发来的。不是的返回 null */
export function parseSessionMessage(text: string): SessionMessage | null {
  const match = SESSION_MESSAGE.exec(text)
  if (!match) return null
  const [head, title, id = ''] = match
  return {
    from: { id, title: title ? title : null },
    message: text.slice(head.length).replace(SESSION_MESSAGE_REPLY, ''),
  }
}
