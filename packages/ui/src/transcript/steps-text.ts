// 过程区里几行汇总的字：步骤组那一行（“读取 3 个文件，运行 2 条命令”）、正在跑的那一条叫什么、
// 回合结束后整段过程收成的那一行。不靠浏览器，单测在 test/steps-text.test.mjs。
import type { ItemView, ProcessTally, StepKind, StepsTally } from '@litch/core'
import type { Translator } from '../i18n/index.ts'

const COUNT_KEYS = {
  read: 'activity.read',
  search: 'activity.search',
  list: 'activity.list',
  web: 'activity.web',
  command: 'activity.command',
  add: 'activity.add',
  update: 'activity.update',
  delete: 'activity.delete',
  tool: 'activity.tool',
  notice: 'activity.notice',
} as const satisfies Record<StepKind, string>

const NOW_KEYS = {
  read: 'activity.now.read',
  search: 'activity.now.search',
  list: 'activity.now.list',
  web: 'activity.now.web',
  command: 'activity.now.command',
  add: 'activity.now.add',
  update: 'activity.now.update',
  delete: 'activity.now.delete',
  tool: 'activity.now.tool',
  notice: 'activity.now.notice',
} as const satisfies Record<StepKind, string>

/** 第一个字母大写（英文的汇总是几段拼起来的，只有开头那段要大写；中文不受影响） */
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/**
 * 步骤组那一行写什么：动作和个数，按先后，思考不计入；只有思考的写“想了一下”；
 * 组里只有一条提示（上下文压缩之类）就写那条提示的话
 */
export function stepsSummary(tally: StepsTally, t: Translator): string {
  const { counts } = tally
  if (counts.length === 0) return t('activity.thought')
  const only = counts.length === 1 ? counts[0] : undefined
  if (only?.kind === 'notice' && only.n === 1 && tally.notice !== null) {
    return t.text(tally.notice)
  }
  return capital(counts.map(({ kind, n }) => t(COUNT_KEYS[kind], { n })).join(t('activity.join')))
}

/**
 * 正在跑的那一条：前面的动词（“正在读取”）和后面的对象（命令、文件、工具名、搜的词）。
 * kind 是核心的 stepKindOf 给的（这里不引核心的代码，好单独测）
 */
export function nowOf(
  item: ItemView,
  kind: StepKind | null,
  t: Translator,
): { label: string; target: string } {
  if (item.kind === 'reasoning') {
    return { label: t('reasoning.running'), target: item.text.split('\n', 1)[0] ?? '' }
  }
  const label = kind ? t(NOW_KEYS[kind]) : t('activity.now.notice')
  switch (item.kind) {
    case 'command':
      return { label, target: item.command }
    case 'fileChange':
      return {
        label,
        target: item.changes.map((change) => change.path.split(/[\\/]/).pop()).join(', '),
      }
    case 'toolCall': {
      const tool = t.text(item.tool)
      // Claude Code 的读、搜投影出来是“Read 路径”：动词已经在前面说了，对象只留后半截
      const rest = kind === 'tool' ? tool : tool.replace(/^\S+\s*/, '') || tool
      return {
        label,
        target: item.source && kind === 'tool' ? `${t.text(item.source)} · ${rest}` : rest,
      }
    }
    case 'webSearch':
      return { label, target: item.query }
    case 'notice':
      return { label: t.text(item.label), target: '' }
    default:
      return { label, target: '' }
  }
}

/** 回合结束后整段过程收成的那一行：前半是“已处理 X · N 段说明 · N 步 · N 个子代理”，后半是标红的几项 */
export function processSummary(
  tally: ProcessTally,
  durationMs: string | null,
  t: Translator,
  ended: 'failed' | 'interrupted' | null,
): { plain: string[]; bad: string[] } {
  const plain = [durationMs ? t('activity.done', { time: durationMs }) : t('activity.doneBare')]
  if (tally.notes > 0) plain.push(t('activity.notes', { n: tally.notes }))
  if (tally.steps > 0) plain.push(t('activity.steps', { n: tally.steps }))
  if (tally.agents > 0) plain.push(t('activity.agents', { n: tally.agents }))
  const bad: string[] = []
  if (tally.failed > 0) bad.push(t('activity.failed', { n: tally.failed }))
  if (tally.declined > 0) bad.push(t('activity.declined', { n: tally.declined }))
  if (tally.agentsFailed > 0) bad.push(t('activity.agentsFailed', { n: tally.agentsFailed }))
  if (ended === 'failed') bad.push(t('turn.failed'))
  if (ended === 'interrupted') bad.push(t('turn.interrupted'))
  return { plain, bad }
}
