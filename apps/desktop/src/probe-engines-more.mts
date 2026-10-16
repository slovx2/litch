// 三个引擎各走一遍的验收（三）：技能、打断、读历史。
// 都在眼前这个会话里做（哪个会话由 probe-engines-run.mts 先点开）。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
import type { EnginesKit } from './probe-engines-kit.mjs'
import type { FilesKit } from './probe-files-kit.mjs'

export interface SkillSeen {
  /** 打了斜杠之后单子上列的命令和技能（带斜杠的名字）；技能那一组没列出东西时写的那句话 */
  commands: string[]
  skills: string[]
  note: string
  /** 选了那项技能之后输入区里带着的那一片上的字 */
  chip: string
  /** 发出去的那条消息在对话里的样子：带着的东西、气泡里的字 */
  carried: string[]
  bubble: string
  foot: string
  answer: string
  /** 侧栏里这一行的标题（技能的正文不该跑到标题里去） */
  rowTitle: string
}

/** 打斜杠、选项目里的那项技能、带着它发一句 */
export async function enginesSkill(name: string, words: string): Promise<SkillSeen> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const { one, all, text, until, frame, write } = files
  const rows = (kind: string) => all(`.dock .sug-opt[data-kind="${kind}"]`)
  const names = (kind: string) => rows(kind).map((row) => text(one('b', row)))
  const note = () => text(one('.dock .sug [data-group="skills"] .sug-note'))
  const chips = () => all('.dock .cmp-chip').map((chip) => text(one('.ell', chip)))

  await kit.idle()
  const input = await until('输入框', kit.area)
  input.focus()
  write(input, '/')
  await until('斜杠的单子', () => one('.dock .sug'), 10_000)
  // 技能是现问的：等它列出来，或者写了一句为什么没有（还在取的时候那句话以省略号结尾）
  await files.seen(() => rows('skill').length > 0 || (note() && !/…$/.test(note())), 30_000)
  await frame()
  const commands = names('command')
  const skills = names('skill')
  const said = note()
  const target = rows('skill').find((row) => text(one('b', row)) === `/${name}`)
  if (!target) {
    // 单子上没有这项技能：后面没法带着它发。把单子收掉，照实报
    write(input, '')
    await frame()
    return {
      commands,
      skills,
      note: said,
      chip: '',
      carried: [],
      bubble: '',
      foot: '',
      answer: '',
      rowTitle: text(one('.ss-row.sel .title')),
    }
  }
  target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  target.click()
  await until('技能的那一片', () => chips().length === 1, 5000)
  const chip = chips()[0] ?? ''
  await kit.send(words)
  await kit.idle()
  const bubble = all('.umsg').findLast((entry) => text(one('.umsg-text', entry)).includes(words))
  return {
    commands,
    skills,
    note: said,
    chip,
    carried: kit.subs(bubble, '.atts .mention').map(text),
    bubble: text(kit.sub(bubble, '.umsg-text')),
    foot: kit.foot(),
    answer: kit.lastAnswer(),
    rowTitle: text(one('.ss-row.sel .title')),
  }
}

export interface InterruptSeen {
  /** 回答流出来之后，发送按钮是不是换成了停止 */
  stopShown: boolean
  /** 点停止的时候回答里最后一段的序号 */
  stoppedAt: number
  /** 点了之后多少毫秒回合停下。二十秒没停是 null */
  stopMs: number | null
  foot: string
  /** 被打断的那个回合里出错框上的字（打断不是出错，不该有框）。没有是空的 */
  errorBox: string
  /** 停下之后回答里最后一段的序号；再过一秒半是不是还是它（没有接着长） */
  endedAt: number
  still: boolean
  /** 停下之后输入框在、能写，发送按钮不再是停止 */
  ready: boolean
  /** 紧接着再发一句：回合怎么结束的、回答是什么 */
  next: { foot: string; answer: string }
}

/** 让假模型慢慢说，流到一半点停止；停下之后再发一句 */
export async function enginesInterrupt(slow: string, next: string): Promise<InterruptSeen> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const { one, until, sleep } = files
  /** 回答里现在最后一段是第几段（假模型一段一句，句句带序号） */
  const piece = () => {
    const found = [...kit.lastAnswer().matchAll(/第 (\d+) 段/g)].at(-1)
    return found ? Number(found[1]) : 0
  }
  const stop = () => one<HTMLButtonElement>('.send.stop')

  await kit.idle()
  await kit.send(slow)
  await until('回答流出来两段', () => piece() >= 2, 60_000)
  const stopShown = Boolean(stop())
  const stoppedAt = piece()
  const clicked = performance.now()
  stop()?.click()
  const stopped = await files.seen(() => !kit.running(), 20_000)
  const stopMs = stopped ? Math.round(performance.now() - clicked) : null
  const foot = kit.foot()
  const endedAt = piece()
  await sleep(1500)
  const still = piece() === endedAt
  const errorBox = files.text(kit.sub(kit.turns().at(-1), '.errbox'))
  const input = kit.area()
  const ready = Boolean(input) && input?.disabled === false && !stop()

  await kit.idle()
  await kit.send(next)
  await kit.idle()
  return {
    stopShown,
    stoppedAt,
    stopMs,
    foot,
    errorBox,
    endedAt,
    still,
    ready,
    next: { foot: kit.foot(), answer: kit.lastAnswer() },
  }
}

/** 眼前这个会话的骨架（见 probe-engines-kit.mts 的 outline） */
export async function enginesOutline(): Promise<string[][]> {
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  await kit.idle()
  return kit.outline()
}

/**
 * 点开侧栏里标题带这段字的会话，等它的内容出来并且读完。返回它有几个回合。
 * 分叉之后同一个标题有两行：给了 has 就挨个点开，要对话里有这句话的那一个
 */
export async function enginesOpen(title: string, has?: string): Promise<number> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const { one, all, text, until } = files
  // 收在“展示更多”后面的也算
  for (const more of all('.ss-more .more')) more.click()
  const rows = () => all('.ss-row').filter((row) => text(one('.title', row)).includes(title))
  await until(`侧栏里的“${title}”`, () => rows().length > 0, 40_000)
  /** 等内容读完：先画手上有的，读到了再换，所以等它连着一秒不再变 */
  const loaded = async () => {
    await until('这个会话的内容', () => kit.turns().length > 0 && kit.area(), 60_000)
    let size = -1
    let since = performance.now()
    await until(
      '会话的内容读完',
      () => {
        const now = one('.tr')?.textContent?.length ?? 0
        if (now !== size) {
          size = now
          since = performance.now()
        }
        return performance.now() - since > 1000
      },
      30_000,
    )
  }
  for (const [index, row] of rows().entries()) {
    row.click()
    await until(`“${title}”成了眼前的会话`, () => row.classList.contains('sel'), 20_000)
    await loaded()
    if (!has || text(one('.tr')).includes(has)) return kit.turns().length
    if (index === rows().length - 1) break
  }
  throw new Error(`标题是“${title}”的会话里没有哪个带着“${has}”这句话`)
}
