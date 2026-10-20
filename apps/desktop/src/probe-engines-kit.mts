// 三个引擎各走一遍的验收里几组脚本共用的那套手，架在文件面板验收的那一套（probe-files-kit.mts）上面：
// 等回合、读请求卡片、读选择器里列了什么、把一个会话读成“骨架”。
// installEnginesKit 被原样送进页面里执行一次（要先装 installFilesKit），之后送进去的验收函数从 window 上取。
// 页面重新加载之后要再装一次。和别的验收一样，函数里不能引用函数外面的东西。
import type { FilesKit } from './probe-files-kit.mjs'

/** 一张请求卡片上看得到的东西 */
export interface CardSeen {
  /** 标题那一行（“要你批准：运行一条命令”“有问题要你回答”） */
  head: string
  /** 正文：命令、目录、原因、题目，一样一行 */
  body: string[]
  /** 底下那排按钮上的字（快捷键的小字不算） */
  buttons: string[]
  /** 提问卡片上有几道题（一道题的没有题号那一排，算 1） */
  steps: number
  /** 提问卡片眼前这道题的选项 */
  options: string[]
  /** 卡片出来时焦点是不是在卡片上 */
  focused: boolean
}

export interface PickerSeen {
  /** 按钮上显示的，就是现在选着的 */
  current: string
  /** 列出来的选项。“添加…”那种不是值的不算 */
  options: { id: string; title: string; note: string; disabled: boolean }[]
}

export interface EnginesKit {
  area(): HTMLTextAreaElement | null
  running(): boolean
  turns(): HTMLElement[]
  /** 最后一个回合里的全部文字 */
  lastTurn(): string
  /** 最后一个回合里露在外面的回答（活动块里的不算） */
  lastAnswer(): string
  /** 等这一轮完全结束：不在跑、没有卡片、没有排着的消息、输入框在 */
  idle(ms?: number): Promise<void>
  /** 在输入框里写一句发出去，等这句话的气泡出来（对面回显的可能比发的多：按“里面有这句话”找） */
  send(words: string): Promise<void>
  /** 发出去之后等着：来了请求卡片就返回它，没来卡片回合就结束了是 null */
  cardOrEnd(ms?: number): Promise<HTMLElement | null>
  /** 等一张请求卡片出来，等焦点安排好 */
  card(ms?: number): Promise<HTMLElement>
  readCard(card: HTMLElement): CardSeen
  /** 点卡片底下那排里写着这几个字的按钮，等这张卡片收掉。没有这个按钮就报错 */
  answer(card: HTMLElement, label: string): Promise<void>
  /** 读一个选择器：点开、读、关上。页面上没有这个选择器是 null */
  picker(kind: string): Promise<PickerSeen | null>
  /** 在一个选择器里选一项，要再确认的照确认 */
  pick(kind: string, id: string): Promise<void>
  /** 把眼前会话里收着的活动块都点开 */
  unfold(): Promise<void>
  /**
   * 眼前的会话读成骨架：一个回合一项，里面依次是用户的话、活动块里的各条（做了什么、对象、状态）、
   * 计划、回答、怎么结束的。耗时不算在里面：它不是内容
   */
  outline(): Promise<string[][]>
  /**
   * 在一个元素里面找。和文件面板那一套的 one、all 不一样的地方：没有这个元素就是找不到，
   * 不会改成在整个页面里找（那样读到的是别处的东西）
   */
  sub<E extends Element = HTMLElement>(root: Element | null | undefined, selector: string): E | null
  subs(root: Element | null | undefined, selector: string): HTMLElement[]
  /** 最后一个回合是怎么结束的（“完成”“已中断”“出错”；还没结束是空的） */
  foot(): string
  /** 页面现在的样子，给报错用 */
  where(): string
}

export function installEnginesKit(): boolean {
  const files = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { one, all, text, frame, sleep } = files
  const sub = <E extends Element = HTMLElement>(
    root: Element | null | undefined,
    selector: string,
  ): E | null => (root ? one<E>(selector, root) : null)
  const subs = (root: Element | null | undefined, selector: string) =>
    root ? all(selector, root) : []
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const turns = () => all('.turn')
  const lastTurn = () => text(turns().at(-1))
  const lastAnswer = () => text(subs(turns().at(-1), ':scope > .md').at(-1))
  const foot = () => text(sub(turns().at(-1), '.turn-foot span'))
  const where = () =>
    JSON.stringify({
      crumb: text(one('.crumb')),
      turns: turns().length,
      running: running(),
      card: text(one('.req')).slice(0, 200),
      tray: all('.tray-row').length,
      hint: text(one('.dock .cmp-hint')),
      last: lastTurn().slice(-300),
      toasts: all('.toast-text').map(text),
    })
  /** 等一件事；等不到的时候把对话当时的样子写进报错 */
  const wait = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 60_000,
  ): Promise<T> => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    throw new Error(`等不到：${what}（当时：${where()}）`)
  }
  const idle = async (ms = 90_000) => {
    // 回合结束的那一帧和卡片收掉的那一帧不一定是同一帧：连着安静一小会儿才算
    let calm = 0
    await wait(
      '这一轮结束',
      () => {
        const quiet = !running() && !one('.req') && !one('.tray-row') && area()
        calm = quiet ? calm || performance.now() : 0
        return calm > 0 && performance.now() - calm > 300
      },
      ms,
    )
  }
  const card = async (ms = 60_000) => {
    const found = await wait('请求卡片', () => one<HTMLElement>('.req'), ms)
    await frame()
    await frame()
    return found
  }
  const send = async (words: string) => {
    const before = turns().length
    const input = await wait('输入框', area, 20_000)
    files.write(input, words)
    await frame()
    files.press(input, 'Enter')
    await wait(
      `“${words}”这一轮`,
      () =>
        turns().length > before && all('.umsg-text').some((entry) => text(entry).includes(words)),
      30_000,
    )
  }
  const cardOrEnd = async (ms = 90_000) => {
    let calm = 0
    const found = await wait(
      '请求卡片或者回合结束',
      () => {
        const shown = one('.req')
        if (shown) return shown
        const quiet = !running() && !one('.tray-row') && area()
        calm = quiet ? calm || performance.now() : 0
        return calm > 0 && performance.now() - calm > 300 ? 'end' : null
      },
      ms,
    )
    if (found === 'end') return null
    await frame()
    await frame()
    return found
  }
  /** 一个按钮上的字，不带快捷键的小字和“以后都允许”记下的那一条 */
  const label = (button: Element) =>
    [...button.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim()
  const readCard = (found: HTMLElement): CardSeen => ({
    head: text(one('.req-head', found)),
    body: [
      ...all('.req-q, .req-body .well pre, .req-body .req-meta, .req-body .req-why', found),
    ].map(text),
    buttons: all('.req-actions .btn', found).map(label),
    steps: Math.max(1, all('.step', found).length),
    options: all('.opt .tx b', found).map(text),
    focused: document.activeElement === found || found.contains(document.activeElement),
  })
  const answer = async (found: HTMLElement, wanted: string) => {
    const button = all('.req-actions .btn', found).find((entry) => label(entry) === wanted)
    if (!button) {
      throw new Error(`卡片上没有“${wanted}”这个按钮（有：${readCard(found).buttons.join('、')}）`)
    }
    button.click()
    await wait(`点了“${wanted}”之后卡片收掉`, () => !found.isConnected, 30_000)
  }
  const pickerOf = (kind: string) => one(`.pick[data-kind="${kind}"]`)
  /** 等点开的选项收起。开着的时候整个选择器被换掉了（底栏在手底下重画）：旧的那个永远收不起来，当场报出来 */
  const folded = (kind: string, root: Element) =>
    wait(
      `“${kind}”的选项收起`,
      () => {
        if (!root.isConnected)
          throw new Error(`“${kind}”的选项开着的时候选择器被换掉了（${where()}）`)
        return !one('.pick-pop', root)
      },
      10_000,
    )
  const picker = async (kind: string): Promise<PickerSeen | null> => {
    const root = pickerOf(kind)
    const button = root ? one<HTMLButtonElement>('.pick-btn', root) : null
    if (!root || !button) return null
    const current = text(button)
    button.click()
    await wait(`“${kind}”的选项`, () => one('.pick-opt', root), 10_000)
    const options = all('.pick-opt', root)
      .filter((option) => option.dataset.action === undefined)
      .map((option) => ({
        id: option.dataset.option ?? '',
        title: text(one('b', option)),
        note: text(one('span', option)),
        disabled: option.getAttribute('aria-disabled') === 'true',
      }))
    button.click()
    await folded(kind, root)
    return { current, options }
  }
  const pick = async (kind: string, id: string) => {
    const root = pickerOf(kind)
    const button = root ? one<HTMLButtonElement>('.pick-btn', root) : null
    if (!root || !button) throw new Error(`页面上没有“${kind}”这个选择器（${where()}）`)
    button.click()
    const option = await wait(
      `“${kind}”里的 ${id}`,
      () => one<HTMLButtonElement>(`.pick-opt[data-option="${id}"]`, root),
      10_000,
    )
    option.click()
    await frame()
    // 要再确认一次的（风险高的权限档）：照确认
    one<HTMLButtonElement>('.pick-ask .btn.danger', root)?.click()
    await folded(kind, root)
    await frame()
  }
  const unfold = async () => {
    for (let round = 0; round < 20; round++) {
      const closed = all(
        '.turn .proc-head[aria-expanded="false"], .turn .steps-head[aria-expanded="false"]',
      )
      if (closed.length === 0) return
      for (const head of closed) head.click()
      await frame()
    }
    throw new Error('对话里有收着的过程或步骤组点不开')
  }
  /** 一条步骤右边的状态：耗时那一格不要 */
  const stateOf = (item: Element) =>
    all('.item-head .meta > span', item)
      .map(text)
      .filter((word) => word && !/^[\d.]+ (毫秒|秒)$|^\d+ 分 \d+ 秒$/.test(word))
      .join(' ')
  const outline = async () => {
    await unfold()
    return turns().map((turn) =>
      [...turn.children].flatMap((block): string[] => {
        if (block.matches('.umsg')) {
          const carried = all('.atts .mention, .atts .uimg', block).map((entry) =>
            entry.matches('.uimg') ? '图' : `@${text(entry)}`,
          )
          return [`用户：${[...carried, text(one('.umsg-text', block))].join(' ')}`]
        }
        // 过程：说明段、步骤组里的每一条、子代理那一行
        if (block.matches('.proc')) {
          return [...(one('.proc-body', block)?.children ?? [])].flatMap((part): string[] => {
            if (part.matches('.md')) return [`说明：${text(part)}`]
            if (part.matches('.steps')) {
              return all('.item', part).map((item) =>
                `${text(one('.verb', item))} ${text(one('.tgt', item))}｜${stateOf(item)}`.trim(),
              )
            }
            return [`${part.className}：${text(part).slice(0, 80)}`]
          })
        }
        // 只有提示的回合（比如只有“上下文已压缩”那一条）提示直接露在外面
        if (block.matches('.notes')) {
          return all('.item', block).map((item) =>
            `${text(one('.verb', item))} ${text(one('.tgt', item))}｜${stateOf(item)}`.trim(),
          )
        }
        if (block.matches('.plan')) return [`计划：${text(one('.plan-body', block))}`]
        if (block.matches('.md')) return [`回答：${text(block)}`]
        if (block.matches('.turn-foot')) return [`结束：${text(one('span', block))}`]
        if (block.matches('.running-line')) return ['还在跑']
        if (block.matches('.errbox')) return [`出错：${text(block)}`]
        return [`${block.className}：${text(block).slice(0, 80)}`]
      }),
    )
  }
  const kit: EnginesKit = {
    area,
    running,
    turns,
    lastTurn,
    lastAnswer,
    idle,
    send,
    cardOrEnd,
    card,
    readCard,
    answer,
    picker,
    pick,
    unfold,
    outline,
    sub,
    subs,
    foot,
    where,
  }
  ;(window as unknown as { __enginesKit: EnginesKit }).__enginesKit = kit
  return true
}
