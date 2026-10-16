// 三个引擎各走一遍的验收（四）：计划模式、改了文件之后的那一条和差异标签、带图片发一条。
// 都在眼前这个会话里做（哪个会话由 probe-engines-run.mts 先点开）。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
import type { DiffKit } from './probe-diff-kit.mjs'
import type { CardSeen, EnginesKit } from './probe-engines-kit.mjs'
import type { FilesKit } from './probe-files-kit.mjs'

export interface PlanSeen {
  /** 底栏上有没有计划模式的开关。没有的话下面都是空的：这个 harness 不会计划模式 */
  offered: boolean
  /** 发之前开关是不是按下的 */
  on: boolean
  /** 对话里计划那一块的字 */
  plan: string
  /** 计划出来之后 harness 自己来问的那张卡片；它在的时候客户端是不是也问了一遍 */
  card: CardSeen | null
  both: boolean
  /** 选的是哪一项 */
  replied: string
  foot: string
  answer: string
  turn: string[]
  /** 回合结束之后：开关还开着吗；客户端自己的那一问（“计划写好了”）在不在、上面有哪几个按钮 */
  onAfter: boolean
  clientAsk: string[] | null
}

/**
 * 打开计划模式让假模型出一份计划；harness 接着来问的话选 choice 那一项。
 * 走完不管落在哪种状态都把计划模式关掉、客户端的那一问收掉，后面的步骤不受它影响
 */
export async function enginesPlan(words: string, choice: string): Promise<PlanSeen> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const { one, all, text, until, frame, sleep } = files
  const button = () => one<HTMLButtonElement>('.dock .mode-btn[data-kind="plan"]')
  const pressed = () => button()?.getAttribute('aria-pressed') === 'true'
  const ask = () => one('.plan-ask')

  await kit.idle()
  if (!button()) {
    return {
      offered: false,
      on: false,
      plan: '',
      card: null,
      both: false,
      replied: '',
      foot: '',
      answer: '',
      turn: [],
      onAfter: false,
      clientAsk: null,
    }
  }
  if (!pressed()) {
    button()?.click()
    await files.seen(pressed, 5000)
  }
  const on = pressed()
  await kit.send(words)
  const shown = await kit.cardOrEnd()
  const card = shown ? kit.readCard(shown) : null
  const both = shown ? Boolean(ask()) : false
  let replied = ''
  if (shown) {
    const option = all('.opt', shown).find((entry) => text(one('.tx b', entry)) === choice)
    if (!option)
      throw new Error(`计划之后的那张卡片上没有“${choice}”（有：${card?.options.join('、')}）`)
    replied = choice
    option.click()
    await until('选了之后卡片收掉', () => !shown.isConnected, 30_000)
  }
  await kit.idle()
  // 开关换不换要经过核心走一个来回：等一小会儿再读
  await sleep(600)
  await frame()
  const last = kit.turns().at(-1)
  const result: PlanSeen = {
    offered: true,
    on,
    plan: text(kit.subs(last, '.plan .plan-body').at(-1)),
    card,
    both,
    replied,
    foot: kit.foot(),
    answer: kit.lastAnswer(),
    turn: (await kit.outline()).at(-1) ?? [],
    onAfter: pressed(),
    clientAsk: ask() ? all('.plan-ask .btn').map(text) : null,
  }
  one<HTMLButtonElement>('.plan-ask [data-act="dismiss"]')?.click()
  if (pressed()) {
    button()?.click()
    await files.seen(() => !pressed(), 5000)
  }
  await frame()
  return result
}

export interface WriteSeen {
  /** 写之前来的那张审批卡片（没来问是 null）；它等着的时候对话里那一条写的是什么；点的是哪个按钮 */
  card: CardSeen | null
  pending: string
  clicked: string
  foot: string
  answer: string
  turn: string[]
  /** “改了文件”那一条点开之后：里面每个文件一行（路径和加减行数）；差异里画出来的字 */
  files: string[]
  shown: string
  /**
   * 从那一条上点“在差异里看”：侧面板的差异标签开了没有；里面列没列这个文件、选中的是不是它；
   * 画出来的内容（各行拼起来）；有没有说“这个文件现在没有没提交的改动”（找不到它时出的那句，没出是空的）。
   * 没有那一条、点不了的时候是 null
   */
  diff: { opened: boolean; listed: boolean; picked: boolean; body: string; missed: string } | null
}

/** 让假模型用它自己的写文件工具新写一个文件；来问就点 label 那个按钮。file 是相对工作目录的路径 */
export async function enginesWrite(words: string, label: string, file: string): Promise<WriteSeen> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const diffs = (window as unknown as { __diffKit: DiffKit }).__diffKit
  const { one, text, frame } = files

  await kit.idle()
  await kit.send(words)
  const waiting = await kit.cardOrEnd()
  const card = waiting ? kit.readCard(waiting) : null
  const pending = waiting ? kit.subs(kit.turns().at(-1), '.item-head').map(text).join('｜') : ''
  if (waiting) await kit.answer(waiting, label)
  await kit.idle()
  const turn = (await kit.outline()).at(-1) ?? []
  // “改了文件”那一条：右边带着加了几行的
  const item = kit
    .subs(kit.turns().at(-1), '.item')
    .findLast((entry) => one('.item-head .meta .plus', entry))
  const head = kit.sub<HTMLButtonElement>(item, '.item-head')
  if (head?.getAttribute('aria-expanded') === 'false') head.click()
  await frame()
  await frame()
  const listed = kit.subs(item, '.file-head').map(text)
  const shown = text(kit.sub(item, '.item-detail')).slice(0, 400)
  const jump = kit.sub<HTMLButtonElement>(item, '.file-diff')
  let diff: WriteSeen['diff'] = null
  if (jump) {
    // 差异里找不到要看的文件时出一句提示，只停几秒：点之前就盯着。
    // 只看“选中的是不是它”不够：没选过的时候差异标签默认选中第一个文件，正好就是它。
    // 上一家留下的那句先关掉（不显示的窗口里它的计时不一定走得动），免得记到这一家头上
    const stale = one<HTMLButtonElement>('[data-toast="diff-wanted"] .toast-x')
    if (stale) {
      stale.click()
      await files.seen(() => files.toast('diff-wanted') === '', 2000)
    }
    let missed = ''
    const watcher = new MutationObserver(() => {
      missed ||= files.toast('diff-wanted')
    })
    watcher.observe(document.body, { childList: true, subtree: true })
    jump.click()
    const opened = await files.seen(() => files.sideOpen() && diffs.box(), 20_000)
    let found = false
    if (opened) {
      await diffs.open()
      // 概况是现取的：没列出来就多等几回
      for (let round = 0; round < 30 && !found; round++) {
        found = (await diffs.paths()).includes(file)
        if (!found) await files.sleep(500)
      }
      if (found) await files.seen(() => diffs.rows(file).length > 0, 20_000)
      // 找不到时要先重新取一遍概况才出那句提示：再给它一小会儿
      if (found) await files.seen(() => missed !== '', 2000)
    }
    watcher.disconnect()
    diff = {
      opened,
      listed: found,
      picked: diffs.treeRow(file)?.getAttribute('aria-current') === 'true',
      body: diffs.rows(file).map(text).join('\n').slice(0, 400),
      missed,
    }
    if (files.sideOpen()) files.toggle()
    await frame()
  }
  return {
    card,
    pending,
    clicked: waiting ? label : '',
    foot: kit.foot(),
    answer: kit.lastAnswer(),
    turn,
    files: listed,
    shown,
    diff,
  }
}

export interface ImageSeen {
  /** 图片贴进输入区了吗；没收的话输入区说了什么 */
  attached: boolean
  hint: string
  /** 发出去的那条消息的气泡里有没有缩略图 */
  pictured: boolean
  foot: string
  answer: string
}

/** 往输入区贴一张图，带着它发一句 */
export async function enginesImage(words: string): Promise<ImageSeen> {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const kit = (window as unknown as { __enginesKit: EnginesKit }).__enginesKit
  const { one, all, text, until } = files

  await kit.idle()
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 200
  const pen = canvas.getContext('2d')
  if (pen) {
    pen.fillStyle = '#2a7'
    pen.fillRect(0, 0, 320, 200)
    pen.fillStyle = '#135'
    pen.fillRect(40, 40, 120, 80)
  }
  const png = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'))
  if (!png) throw new Error('画不出测试用的图片')
  const clipboard = new DataTransfer()
  clipboard.items.add(new File([png], 'image.png', { type: 'image/png' }))
  const input = await until('输入框', kit.area)
  input.dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }),
  )
  const attached = await files.seen(() => all('.dock .cmp-att').length === 1, 5000)
  const hint = text(one('.dock .cmp-hint'))
  if (!attached) return { attached, hint, pictured: false, foot: '', answer: '' }
  await kit.send(words)
  await kit.idle()
  const bubble = all('.umsg').findLast((entry) => text(one('.umsg-text', entry)).includes(words))
  return {
    attached,
    hint,
    pictured: Boolean(kit.sub(bubble, '.uimg')),
    foot: kit.foot(),
    answer: kit.lastAnswer(),
  }
}
