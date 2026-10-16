// 请求卡片和输入框并存的验收：请求（审批、提问、表单）出现在输入框上面，输入框照常在、照常能写。
// 排在 check:compose 的最后（probe-session 之后），模拟核心和真实入口都跑：
// - cardsProbe：平常大小的窗口。空草稿时焦点让给卡片、数字键能答、答完焦点回输入框；
//   草稿不是空的就不抢焦点、字还在；请求挂着时发的消息进队列，答完照序发出；
// - cardRoomProbe：窗口缩到最小之后再让请求出现一次（起自检的一方缩好窗口），模拟核心上再开着终端面板来一次。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
// 让对面提问的话：模拟核心里带“问一句”是一道题、带“提问”是三道题；真实入口的假模型听到“问我”先后问两道。

/** 卡片和输入框摆得对不对。faults 是出的岔子，没有就是空的 */
export interface CardRoom {
  faults: string
  /** 卡片多高、输入框多高（像素） */
  cardHeight: number
  inputHeight: number
  /** 卡片里的内容比卡片高，在它里面滚 */
  scrolls: boolean
}

export interface CardsProbe {
  /** 草稿是空的、焦点停在输入框里的时候来了请求 */
  empty: {
    /** 输入框还是原来那个，没有被换掉 */
    inputKept: boolean
    /** 焦点到了卡片上 */
    focusOnCard: boolean
    room: CardRoom
    /** 卡片里能按的东西都排在输入框前面、都在 Tab 的路上，Tab 键没有被谁拦下 */
    tabPath: boolean
    /** 数字键答了，卡片没了，焦点回到输入框 */
    answered: boolean
    focusBack: boolean
  }
  /** 请求来的时候正在输入框里写着东西 */
  busy: {
    /** 焦点还在输入框里，写的字一个没少 */
    focusKept: boolean
    textKept: boolean
    room: CardRoom
    /** 在输入框里按数字键是打字，不是作答 */
    keysStayed: boolean
    /** 请求挂着的时候发了两句：都进了队列（托盘里的顺序），没有直接发出去，卡片还在 */
    queued: string[]
    held: boolean
    /** 把请求答了之后，排着的两句照原来的顺序发了出去（对话里最后两句用户的话） */
    order: string[]
    /** 这中间输入框一直是同一个 */
    inputKept: boolean
  }
}

export async function cardsProbe(real: boolean): Promise<CardsProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 30_000,
  ) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    throw new Error(`请求卡片和输入框：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const users = () => all('.umsg-text').map(text)
  const running = () => Boolean(one('.running-line'))
  const write = (target: HTMLTextAreaElement | HTMLInputElement, words: string) => {
    const proto =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, words)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }
  const card = () => (all('.req .opt').length > 0 ? one<HTMLElement>('.req') : null)
  const tray = () => all('.tray-row').map((row) => text(one('.ell', row)))

  /** 卡片和输入框现在摆得对不对 */
  const room = (): CardRoom => {
    const found: string[] = []
    const shell = one('.req')
    const frameBox = shell?.getBoundingClientRect()
    const box = one('.dock .cmp')?.getBoundingClientRect()
    const field = area()
    const main = one('.main')?.getBoundingClientRect()
    if (!shell || !frameBox || !box || !field || !main) {
      return { faults: '卡片或者输入框不在', cardHeight: 0, inputHeight: 0, scrolls: false }
    }
    if (frameBox.bottom > box.top + 0.5) found.push('卡片压着输入框')
    if (frameBox.top < main.top - 0.5) found.push('卡片伸到了主区域上面')
    if (
      box.top < main.top - 0.5 ||
      box.bottom > Math.min(main.bottom, window.innerHeight) + 0.5 ||
      box.left < main.left - 0.5 ||
      box.right > Math.min(main.right, window.innerWidth) + 0.5
    ) {
      found.push('输入框伸到了窗口外面')
    }
    const panel = one('.term-dock')
    if (panel && !panel.hidden && box.bottom > panel.getBoundingClientRect().top + 0.5) {
      found.push('输入框伸到了终端面板底下')
    }
    // 没有被别的东西盖住：输入框正中那一点上就是它自己
    const at = field.getBoundingClientRect()
    if (document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2) !== field) {
      found.push('输入框被盖住了')
    }
    const acts = one('.req-actions', shell)?.getBoundingClientRect()
    if (acts && (acts.bottom > frameBox.bottom + 0.5 || acts.top < frameBox.top - 0.5)) {
      found.push('卡片底下那排按钮不在卡片里')
    }
    return {
      faults: found.join('、'),
      cardHeight: Math.round(frameBox.height),
      inputHeight: Math.round(box.height),
      scrolls: shell.scrollHeight > shell.clientHeight + 1,
    }
  }

  /** 把眼前这个请求答掉：数字键选第二个；真实入口还有紧跟着的第二问，写一句回车 */
  const answer = async (from: HTMLElement) => {
    from.focus()
    press(from, '2')
    if (real) {
      const field = await until('第二问的输入框', () =>
        all('.req .opt').length > 0 ? null : one<HTMLInputElement>('.req input.req-input'),
      )
      await frame()
      write(field, '别动数据库')
      await frame()
      press(field, 'Enter')
    }
    await until('提问卡片消失', () => !one('.req'), 60_000)
  }
  const idle = () => until('这一轮结束', () => !running() && !one('.req') && area(), 120_000)

  const main = real ? '给首页加一个状态条' : '首页文案'
  const ask = real ? '再问我两个问题' : '问一句就行'
  const row = await until(`侧栏里的“${main}”`, () =>
    all('.ss-row').find((entry) => text(entry).includes(main)),
  )
  row.click()
  await until(`“${main}”的内容`, () => text(one('.crumb')).includes(main) && one('.turn'))
  await idle()
  const input = await until('输入框', area)
  if (input.value) write(input, '')
  input.focus()
  await frame()

  // ---- 一、草稿是空的：请求一来焦点让给卡片，输入框还在 ----
  write(input, ask)
  await frame()
  press(input, 'Enter')
  const first = await until('提问卡片', card, 60_000)
  await frame()
  await frame()
  const emptyRoom = room()
  const focusOnCard = document.activeElement === first
  const inputStayed = area() === input && input.isConnected
  // Tab 的路：卡片里能按的都排在输入框前面，没有哪个被踢出 Tab 顺序；Tab 键在卡片上、输入框里都没人拦
  const buttons = all('button:not(:disabled)', first)
  const tabPath =
    buttons.length > 0 &&
    buttons.every(
      (button) =>
        button.tabIndex >= 0 &&
        Boolean(button.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING),
    ) &&
    input.tabIndex >= 0 &&
    [first, buttons[0] as HTMLElement, input].every(
      (target) =>
        !press(target, 'Tab').defaultPrevented &&
        !press(target, 'Tab', { shiftKey: true }).defaultPrevented,
    )
  await answer(first)
  await frame()
  await frame()
  const focusBack = document.activeElement === area()
  await idle()
  const empty: CardsProbe['empty'] = {
    inputKept: inputStayed,
    focusOnCard,
    room: emptyRoom,
    tabPath,
    answered: true,
    focusBack,
  }

  // ---- 二、正写着东西：请求来了不抢焦点；这时发出去的排队，答完照序发出 ----
  input.focus()
  write(input, ask)
  await frame()
  // 请求还没到就接着写。回车和下一句之间不能让出去：模拟的对面收到话当场就提问，中间哪怕只等一帧，
  // 慢机器上卡片也可能先出来——那时输入框是空的，焦点本来就该给卡片，量到的就不是“正写着东西”这种情形了
  //（流水线上出过一次）。发送是在回车这一下里同步清空输入框的，紧跟着写不会被清掉
  const half = '请求来之前就在写的话'
  press(input, 'Enter')
  const arrivedFirst = card() !== null
  write(input, half)
  if (arrivedFirst) throw new Error('验收自己没赶上：字还没写，第二次的提问卡片就已经在了')
  const second = await until('第二次的提问卡片', card, 60_000)
  await frame()
  await frame()
  await sleep(150)
  const focusKept = document.activeElement === input
  const textKept = input.value === half
  const busyRoom = room()
  // 在输入框里按数字键：那是打字，不能当成作答
  press(input, '1')
  await sleep(350)
  const keysStayed =
    one('.req') === second &&
    all('.req .opt').every((option) => option.getAttribute('aria-checked') !== 'true')
  // 把写的这句发出去，再发一句：请求还挂着，都该排队
  const waiting = ['请求挂着时发的头一句', '请求挂着时发的后一句']
  write(input, waiting[0] as string)
  await frame()
  press(input, 'Enter')
  await until('头一句进了队列', () => tray().length === 1, 10_000).catch(() => null)
  write(input, waiting[1] as string)
  await frame()
  press(input, 'Enter')
  await until('后一句也进了队列', () => tray().length === 2, 10_000).catch(() => null)
  const queued = tray()
  const held = one('.req') === second && !users().some((said) => waiting.includes(said))
  await answer(second)
  await until(
    '排着的两句都发出去',
    () => waiting.every((said) => users().includes(said)) && tray().length === 0,
    120_000,
  )
  await idle()
  const busy: CardsProbe['busy'] = {
    focusKept,
    textKept,
    room: busyRoom,
    keysStayed,
    queued,
    held,
    order: users().slice(-2),
    inputKept: area() === input && input.isConnected,
  }
  return { empty, busy }
}

export interface CardRoomProbe {
  /** 量的时候窗口里面多宽多高；终端面板开着的话它多高（收着是 0） */
  width: number
  height: number
  panel: number
  /** 请求出现的那一刻 */
  room: CardRoom
  /** 卡片滚到底：底下那排按钮还看得见，输入框没有跟着动 */
  scrolledRoom: CardRoom
  /** 草稿写了十几行、输入框长到了它的上限：被压矮的是卡片，输入框整个还在窗口里 */
  longDraftRoom: CardRoom
  /** 用上下键挪到后面的选项（过了最后一项是“其他”的输入框）：挪到的那一样在卡片里看得见 */
  optionSeen: boolean
  /** 焦点在终端里的时候来了请求：不抢。只在开着终端面板的那一遍量 */
  terminalKept: boolean | null
}

/**
 * 窗口已经由起自检的一方缩到最小。让对面再提一次问，看卡片和输入框摆得对不对。
 * terminal：先把终端面板打开再量（只在模拟核心上这样做：打开面板会顺手开一个终端）
 */
export async function cardRoomProbe(real: boolean, terminal: boolean): Promise<CardRoomProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 30_000,
  ) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    throw new Error(`矮窗口里的请求卡片：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const write = (target: HTMLTextAreaElement | HTMLInputElement, words: string) => {
    const proto =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, words)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: EventTarget, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  const panel = () => one('.term-dock')
  const panelOpen = () => {
    const dock = panel()
    return Boolean(dock && !dock.hidden && dock.offsetHeight > 0)
  }

  const room = (): CardRoom => {
    const found: string[] = []
    const shell = one('.req')
    const frameBox = shell?.getBoundingClientRect()
    const box = one('.dock .cmp')?.getBoundingClientRect()
    const field = area()
    const main = one('.main')?.getBoundingClientRect()
    if (!shell || !frameBox || !box || !field || !main) {
      return { faults: '卡片或者输入框不在', cardHeight: 0, inputHeight: 0, scrolls: false }
    }
    if (frameBox.bottom > box.top + 0.5) found.push('卡片压着输入框')
    if (frameBox.top < main.top - 0.5) found.push('卡片伸到了主区域上面')
    if (
      box.top < main.top - 0.5 ||
      box.bottom > Math.min(main.bottom, window.innerHeight) + 0.5 ||
      box.left < main.left - 0.5 ||
      box.right > Math.min(main.right, window.innerWidth) + 0.5
    ) {
      found.push('输入框伸到了窗口外面')
    }
    const dock = panel()
    if (dock && !dock.hidden && box.bottom > dock.getBoundingClientRect().top + 0.5) {
      found.push('输入框伸到了终端面板底下')
    }
    const at = field.getBoundingClientRect()
    if (document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2) !== field) {
      found.push('输入框被盖住了')
    }
    const acts = one('.req-actions', shell)?.getBoundingClientRect()
    if (acts && (acts.bottom > frameBox.bottom + 0.5 || acts.top < frameBox.top - 0.5)) {
      found.push('卡片底下那排按钮不在卡片里')
    }
    return {
      faults: found.join('、'),
      cardHeight: Math.round(frameBox.height),
      inputHeight: Math.round(box.height),
      scrolls: shell.scrollHeight > shell.clientHeight + 1,
    }
  }

  // 等窗口的大小定下来（起自检的一方刚改过）
  const settle = performance.now() + 5000
  let last = ''
  while (performance.now() < settle) {
    await sleep(120)
    const size = `${window.innerWidth}x${window.innerHeight}`
    if (size === last) break
    last = size
  }
  await until('这一轮结束', () => !running() && !one('.req') && area(), 120_000)
  const input = await until('输入框', area)
  if (input.value) write(input, '')
  // 开着终端面板的那一遍：先打开面板（焦点会进终端），再让对面提问——请求来了不能把焦点从终端里抢走。
  // 往输入框里写字、按回车都是直接给它发事件，不用把焦点挪过去
  let inTerminal: Element | null = null
  if (terminal) {
    one<HTMLButtonElement>('.tb-term')?.click()
    await until('终端面板打开', panelOpen)
    inTerminal = await until(
      '焦点进了终端',
      () => (document.activeElement?.closest('.term-dock') ? document.activeElement : null),
      10_000,
    ).catch(() => null)
  } else {
    input.focus()
  }
  await frame()
  write(input, real ? '再问我两个问题' : '再提问一次')
  await frame()
  press(input, 'Enter')
  const card = await until(
    '提问卡片',
    () => (all('.req .opt').length > 0 ? one<HTMLElement>('.req') : null),
    60_000,
  )
  await frame()
  await frame()
  await sleep(200)
  const terminalKept = terminal
    ? inTerminal !== null && document.activeElement === inTerminal
    : null
  const seen = room()
  const panelHeight = panelOpen() ? (panel()?.offsetHeight ?? 0) : 0

  // 用键盘往下挪：挪到的那一样（选中的选项，或者“其他”的输入框）在卡片里看得见，没有被底下那排按钮挡住
  card.focus()
  for (let step = 0; step < 3; step++) {
    press(card, 'ArrowDown')
    await sleep(120)
  }
  await frame()
  const target =
    one('.req input.req-input') ??
    all('.req .opt')
      .filter((option) => option.getAttribute('aria-checked') === 'true')
      .at(-1)
  const view = card.getBoundingClientRect()
  const floor = one('.req-actions', card)?.getBoundingClientRect().top ?? view.bottom
  const at = target?.getBoundingClientRect()
  const optionSeen = Boolean(at && at.top >= view.top - 0.5 && at.bottom <= floor + 0.5)

  // 滚到底
  card.scrollTop = card.scrollHeight
  await frame()
  const scrolledRoom = room()

  // 草稿写得很长：输入框长到它的上限，被压的还是卡片
  write(input, Array.from({ length: 14 }, (_, line) => `第 ${line + 1} 行`).join('\n'))
  await frame()
  await frame()
  const longDraftRoom = room()
  write(input, '')
  await frame()
  await frame()

  // 把请求答掉，收拾好
  if (real) {
    const field = one<HTMLInputElement>('.req input.req-input')
    // 挪到了“其他”上：写一句回车就是答了；不然按数字键选第二个
    if (field) {
      write(field, '只改适配器')
      await frame()
      press(field, 'Enter')
    } else {
      card.focus()
      press(card, '2')
    }
    const next = await until('第二问的输入框', () =>
      all('.req .opt').length > 0 ? null : one<HTMLInputElement>('.req input.req-input'),
    )
    await frame()
    write(next, '别动数据库')
    await frame()
    press(next, 'Enter')
  } else {
    // 三道题挨个跳过，跳过最后一道就交了
    for (let page = 0; page < 3; page++) {
      const skip = await until('“跳过”', () =>
        one<HTMLButtonElement>('.req [data-act="skip"]:not(:disabled)'),
      )
      skip.click()
      await sleep(80)
    }
  }
  await until('提问卡片消失', () => !one('.req'), 60_000)
  await until('这一轮结束', () => !running() && area(), 120_000)
  if (terminal) {
    // 紧挨着的两次开合只算一次，隔一会儿再收
    await sleep(250)
    one<HTMLButtonElement>('.tb-term')?.click()
    await until('终端面板收起', () => !panelOpen())
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    panel: panelHeight,
    room: seen,
    scrolledRoom,
    longDraftRoom,
    optionSeen,
    terminalKept,
  }
}

/** short：窗口缩到最小量的；withTerminal：再开着终端面板量的（只有模拟核心有） */
export function judgeCards(
  probe: CardsProbe,
  short: CardRoomProbe,
  withTerminal: CardRoomProbe | null,
  real: boolean,
): string[] {
  const failed: string[] = []
  const { empty, busy } = probe
  if (!empty.inputKept) failed.push('请求出现的时候输入框不在了，或者被换成了另一个')
  if (empty.room.faults) failed.push(`请求出现时（草稿是空的）：${empty.room.faults}`)
  if (!empty.focusOnCard) failed.push('草稿是空的，请求来了焦点没有到卡片上')
  if (!empty.tabPath) failed.push('卡片和输入框之间用 Tab 走不通')
  if (!empty.focusBack) failed.push('请求答完之后焦点没有回到输入框')
  if (!busy.focusKept) failed.push('正在输入框里写着东西，请求来了把焦点抢走了')
  if (!busy.textKept) failed.push('请求来了之后，输入框里写了一半的字没了')
  if (busy.room.faults) failed.push(`请求出现时（正写着东西）：${busy.room.faults}`)
  if (!busy.keysStayed) failed.push('焦点在输入框里的时候按数字键，被卡片当成了作答')
  const waiting = '请求挂着时发的头一句|请求挂着时发的后一句'
  if (busy.queued.join('|') !== waiting) {
    failed.push(`请求挂着的时候发的消息没有照着排队：${busy.queued.join('、')}`)
  }
  if (!busy.held) failed.push('请求还挂着，排队的消息就发出去了，或者卡片没了')
  if (busy.order.join('|') !== waiting) {
    failed.push(`请求答完之后，排着的消息没有照原来的顺序发出去：${busy.order.join('、')}`)
  }
  if (!busy.inputKept) failed.push('请求出现、消失的过程中输入框被换掉了')

  for (const [name, seen] of [
    ['最小的窗口', short],
    ['最小的窗口、开着终端面板', withTerminal],
  ] as const) {
    if (!seen) continue
    if (seen.room.faults) failed.push(`${name}：${seen.room.faults}`)
    if (seen.scrolledRoom.faults)
      failed.push(`${name}，卡片滚到底之后：${seen.scrolledRoom.faults}`)
    if (!seen.optionSeen) failed.push(`${name}：用键盘挪到的选项在卡片里看不见`)
    if (seen.room.inputHeight !== seen.scrolledRoom.inputHeight) {
      failed.push(`${name}：卡片一滚，输入框的高度变了`)
    }
    if (seen.longDraftRoom.faults) {
      failed.push(`${name}，草稿写了十几行的时候：${seen.longDraftRoom.faults}`)
    }
    if (seen.longDraftRoom.inputHeight < seen.room.inputHeight + 100) {
      failed.push(
        `${name}：草稿写了十几行，输入框没有跟着长高（${seen.room.inputHeight} → ${seen.longDraftRoom.inputHeight}）`,
      )
    }
    // 三道题的那张卡片比最小的窗口里留给它的地方高：它应该在自己里面滚
    if (!real && !seen.room.scrolls) failed.push(`${name}：卡片放不下的时候没有在自己里面滚`)
    if (seen.terminalKept === false) failed.push(`${name}：焦点在终端里，请求来了把它抢走了`)
  }
  if (withTerminal && withTerminal.panel <= 0) failed.push('开着终端面板的那一遍，面板没有打开')
  return failed
}
