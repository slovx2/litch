// 三个引擎各走一遍的验收（五）：分叉、编辑重发、压缩。harness 声明了会的才有入口，没有入口的照实记“没有”。
// 都在眼前这个会话里做（哪个会话由 probe-engines-run.mts 先点开）；这几样会改会话，排在最后。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
import type { EnginesKit } from './probe-engines-kit.mjs'
import type { FilesKit } from './probe-files-kit.mjs'

export interface ActsOffered {
  /** 一条用户消息上的“分叉”“编辑”，上下文圆环里的“压缩上下文”：有、没有，或者停着（连同为什么） */
  fork: string
  edit: string
  compact: string
  /** 先发的那两句各自的回答 */
  answers: string[]
}

/** 先发两句（后面分叉、编辑拿它们当靶子），再看三个入口在不在 */
export async function enginesActs(earlier: string, later: string): Promise<ActsOffered> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const { one, all, text, until, frame, press } = files
  const state = (button: HTMLButtonElement | null) =>
    !button
      ? '没有'
      : button.disabled || button.getAttribute('aria-disabled') === 'true'
        ? `停着：${button.title || text(button)}`
        : '有'
  const answers: string[] = []
  for (const words of [earlier, later]) {
    await kit.idle()
    await kit.send(words)
    await kit.idle()
    answers.push(kit.lastAnswer())
  }
  const bubble = all('.umsg').findLast((entry) => text(one('.umsg-text', entry)).includes(earlier))
  const fork = state(kit.sub<HTMLButtonElement>(bubble, '.act-fork'))
  const edit = state(kit.sub<HTMLButtonElement>(bubble, '.act-edit'))
  let compact = '没有上下文圆环'
  const meter = one<HTMLButtonElement>('.ctx-btn')
  if (meter) {
    meter.click()
    await until('上下文的浮层', () => one('.ctx-pop'), 5000)
    const entry = one<HTMLButtonElement>('.ctx-pop .ctx-compact')
    compact = state(entry)
    press(entry ?? one('.ctx-pop') ?? meter, 'Escape')
    await files.seen(() => !one('.ctx-pop'), 3000)
    if (one('.ctx-pop')) meter.click()
    await frame()
  }
  return { fork, edit, compact, answers }
}

export interface ForkSeen {
  /** 点了之后侧栏多了一行、选中的换成了它 */
  opened: boolean
  /** 新会话里有几个回合（原来的有几个）；先发的那句在不在、后发的那句在不在 */
  turns: number
  turnsBefore: number
  hasEarlier: boolean
  hasLater: boolean
  /** 提示里说了什么；新会话那一行的标题和徽标 */
  told: string
  rowTitle: string
  rowHarness: string
  /** 在新会话里再发一句 */
  next: { foot: string; answer: string }
  /** 回到原来的会话：回合一个没少，新会话里说的那句不在这里 */
  sourceKept: boolean
}

/** 从先发的那一句上分叉；在分叉出来的会话里再说一句；回到原来的会话 */
export async function enginesFork(
  earlier: string,
  later: string,
  aside: string,
): Promise<ForkSeen> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const { one, all, text, until, frame } = files
  const bubble = (words: string) =>
    all('.umsg').findLast((entry) => text(one('.umsg-text', entry)).includes(words))

  await kit.idle()
  const source = one('.ss-row.sel')
  const rowsBefore = all('.ss-row').length
  const turnsBefore = kit.turns().length
  const button = kit.sub<HTMLButtonElement>(bubble(earlier), '.act-fork')
  if (!button) throw new Error('先发的那一句上没有分叉的入口')
  button.click()
  const opened = await files.seen(
    () => all('.ss-row').length === rowsBefore + 1 && one('.ss-row.sel') !== source,
    30_000,
  )
  if (!opened) {
    throw new Error(`点了分叉，侧栏没有多出一行（提示：${all('.toast').map(text).join('｜')}）`)
  }
  await until('分叉出来的会话的内容', () => kit.turns().length > 0 && bubble(earlier), 30_000)
  await kit.idle()
  await frame()
  const row = one('.ss-row.sel')
  const seen = {
    opened,
    turns: kit.turns().length,
    turnsBefore,
    hasEarlier: Boolean(bubble(earlier)),
    hasLater: Boolean(bubble(later)),
    told: text(one('.toast[data-toast="turn-action"]')),
    rowTitle: text(kit.sub(row, '.title')),
    rowHarness: kit.sub(row, '.chip')?.title ?? '',
  }
  await kit.send(aside)
  await kit.idle()
  const next = { foot: kit.foot(), answer: kit.lastAnswer() }
  // 回到原来那个会话：分叉之前选中的那一行
  if (!source?.isConnected) throw new Error('原来那个会话的那一行不在侧栏里了')
  source.click()
  await until('原来的会话', () => one('.ss-row.sel') === source && bubble(later), 30_000)
  // 对话区先画最后几个回合、更早的分批往前补（ui 的 turn-window.ts）：等画全了再数，等不到照实数
  await files.seen(() => kit.turns().length >= turnsBefore, 10_000)
  await frame()
  return {
    ...seen,
    next,
    sourceKept: kit.turns().length === turnsBefore && !bubble(aside),
  }
}

export interface EditSeen {
  /** 编辑框里原来是什么，下面的说明写了什么 */
  original: string
  note: string
  /** 改过的那句发出去之后：后发的那一句没了，换成改过的那句，回合数不变 */
  replaced: boolean
  turns: number
  turnsBefore: number
  /** 提示里说了什么（没做成的时候） */
  told: string
  /** 改过的那句开的回合 */
  next: { foot: string; answer: string }
}

/** 把后发的那一句原地改成另一句，按回车：回退到它之前、用改过的字重发 */
export async function enginesEdit(later: string, again: string): Promise<EditSeen> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const { one, all, text, until, frame, write, press } = files
  const bubble = (words: string) =>
    all('.umsg:not(.editing)').findLast((entry) => text(one('.umsg-text', entry)).includes(words))
  const editor = () => one<HTMLTextAreaElement>('.umsg.editing textarea.umsg-edit')

  await kit.idle()
  const turnsBefore = kit.turns().length
  const button = kit.sub<HTMLButtonElement>(bubble(later), '.act-edit')
  if (!button) throw new Error('后发的那一句上没有编辑的入口')
  button.click()
  const box = await until('编辑框', editor, 10_000)
  await frame()
  const original = box.value
  const note = text(one('.umsg.editing .umsg-edit-note')).slice(0, 200)
  write(box, again)
  await frame()
  press(box, 'Enter')
  const replaced = await files.seen(
    () => !editor() && !bubble(later) && Boolean(bubble(again)),
    30_000,
  )
  await frame()
  const told = all('.toast').map(text).join('｜')
  await kit.idle()
  return {
    original,
    note,
    replaced,
    turns: kit.turns().length,
    turnsBefore,
    told,
    next: { foot: kit.foot(), answer: kit.lastAnswer() },
  }
}

export interface CompactSeen {
  /** 点了“压缩上下文”之后对话里多了一个回合（Pi 嫌会话太小不压时不开回合，只出一条“没压缩成”的提示） */
  ran: boolean
  /** 那个回合里的活动是不是收着的（要点开才看得到“上下文已压缩”）；它的骨架、怎么结束的；没做成的话提示里说了什么 */
  folded: boolean
  turn: string[]
  foot: string
  told: string
  /** 压缩之后再发一句 */
  next: { foot: string; answer: string }
}

/** 从上下文圆环里手动压缩一次，之后再发一句 */
export async function enginesCompact(after: string): Promise<CompactSeen> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const { one, all, text, until, frame } = files

  await kit.idle()
  const turnsBefore = kit.turns().length
  ;(await until('上下文圆环', () => one<HTMLButtonElement>('.ctx-btn'), 10_000)).click()
  const entry = await until('“压缩上下文”', () => one<HTMLButtonElement>('.ctx-pop .ctx-compact'))
  entry.click()
  // 压了是多出一个回合；没压是出一条“没压缩成”的提示，那就再等一会儿，看后面有没有冒出回合来
  const refused = () => one('[data-toast="compact-failed"]')
  await files.seen(() => kit.turns().length > turnsBefore || refused(), 30_000)
  if (refused()) await files.sleep(1_500)
  const ran = kit.turns().length > turnsBefore
  await kit.idle(120_000)
  await frame()
  const seen = {
    ran,
    folded: ran && Boolean(kit.sub(kit.turns().at(-1), '.proc-head[aria-expanded="false"]')),
    turn: ran ? ((await kit.outline()).at(-1) ?? []) : [],
    foot: ran ? kit.foot() : '',
    told: all('.toast').map(text).join('｜'),
  }
  await kit.send(after)
  await kit.idle()
  return { ...seen, next: { foot: kit.foot(), answer: kit.lastAnswer() } }
}
