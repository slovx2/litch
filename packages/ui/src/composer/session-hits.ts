// 打 `@` 弹出的单子里“会话”那一组：挑哪些会话、怎么排，选中之后正文里写成什么。
// 纯逻辑：test/session-hits.test.mjs 直接引这个文件，所以只用可擦除的语法、不引样式和组件，也不引核心的实现。
import { rank } from './suggest.ts'

/** 单子里的一个会话。标题已经是写进 @[…] 的样子（核心的 mentionTitle 整理过） */
export interface SessionCandidate {
  id: string
  title: string
  harness: string
  /** 所在工作区的名字；不属于工作区的是空字符串 */
  workspace: string
  workspaceId: string | null
  cwd: string
  /** 毫秒 */
  updatedAt: number
}

/** 没打字时列几个（最近更新的），打了字最多列几个 */
export const RECENT_SESSIONS = 5
export const MATCHED_SESSIONS = 8

/** 目录的最后一段 */
const tail = (path: string): string => path.replace(/\/+$/, '').split('/').pop() ?? ''

/**
 * 按打的字挑会话。去掉当前会话和已经提到的；打的字里有 `/` 是在打路径，一个都不出。
 * 对得一样好的，和当前会话同一个工作区的在前，再按最近更新
 */
export function sessionHits(
  all: readonly SessionCandidate[],
  options: {
    query: string
    current: string | null
    workspaceId: string | null
    bound: ReadonlySet<string>
  },
): SessionCandidate[] {
  const query = options.query.trim()
  if (query.includes('/')) return []
  const left = all
    .filter((one) => one.id !== options.current && !options.bound.has(one.id))
    .map((one) => ({
      one,
      near: options.workspaceId !== null && one.workspaceId === options.workspaceId ? 0 : 1,
    }))
  if (!query) {
    return left
      .sort((a, b) => b.one.updatedAt - a.one.updatedAt)
      .slice(0, RECENT_SESSIONS)
      .map(({ one }) => one)
  }
  const ordered = left
    .sort((a, b) => a.near - b.near || b.one.updatedAt - a.one.updatedAt)
    .map(({ one }) => ({
      one,
      words: [one.title, one.workspace, tail(one.cwd), one.harness, one.id.slice(0, 8)].filter(
        Boolean,
      ),
    }))
  return rank(ordered, query)
    .slice(0, MATCHED_SESSIONS)
    .map(({ one }) => one)
}

/**
 * 选中一个会话：把正在打的 `@查询`（start 到 end）换成 `@[标题]` 加一个空格（后面本来就是空白的不加），
 * 返回新的字和光标落的位置
 */
export function insertMention(
  text: string,
  range: { start: number; end: number },
  title: string,
): { text: string; caret: number } {
  const before = text.slice(0, range.start)
  const after = text.slice(range.end)
  const token = `@[${title}]${/^\s/.test(after) ? '' : ' '}`
  return { text: before + token + after, caret: before.length + token.length }
}

/**
 * 正文里已经没有 @[标题] 的那些会话不再记着（用户把那几个字删了）。都还在的返回原来的数组，
 * 免得每打一个字都换一份、重画一遍
 */
export function keepMentioned<T extends { kind: string }>(extras: T[], text: string): T[] {
  const kept = extras.filter(
    (extra) =>
      extra.kind !== 'session' || text.includes(`@[${(extra as { title?: string }).title}]`),
  )
  return kept.length === extras.length ? extras : kept
}
