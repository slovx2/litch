// “回合进行中发消息”两档的验收，只对着模拟核心量（话里带“跑一会儿”时回合里先跑两秒多的命令，见 mock-core.mts）。
// 在设置页“对话”一组里点立即发送：回合进行中发的消息不进托盘，直接插进同一个回合，提示和按钮说的也是这个；
// 点排队：发的消息进托盘，提示和按钮说排队，托盘里点“现在就说”照样插进去。量完回到排队（前面几段验收量的是排队）。
// harness 插不了话时退回排队那一路（模拟核心里没有插不了话的 harness）由单测 packages/ui/test/send-mode.test.mjs 管。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。

export interface SendModeProbe {
  /** 设置页“对话”一组里的两档 */
  choices: string[]
  /** 立即发送：回合进行中输入框的提示、发送按钮上写的；发出去没进托盘、插在同一个回合里 */
  steerHint: string
  steerButton: string
  steered: boolean
  /** 没插进去时看的：在跑的回合、按下时还在不在跑、进没进过托盘、这句话在哪些回合里、按下前后各回合 */
  steerDetail: string
  /** 排队：提示、按钮；发出去进了托盘；托盘里点“现在就说”插进同一个回合 */
  queueHint: string
  queueButton: string
  queued: boolean
  manualSteered: boolean
  /**
   * 托盘行尾“立即插入”的图标（svg 路径）和查找栏“上一处”那种折线。“立即插入”自成一样：
   * 不是折线，也不是发送箭头（发送箭头取停止后发送键上的那个，见 held.sendKey；回合在跑时那里是停止键）
   */
  icons: { steer: string; chevron: string }
  /**
   * 停止后的待发：一行头“N 条待发 · 全部发送”；每条一行，行尾图标按钮带悬停提示和读屏名称；
   * 行里不重复状态；“连同待发”只在有字时出现在发送键旁，点了换档；全部发送后托盘收起
   */
  held: {
    head: string
    rows: number
    rowHeights: number[]
    buttons: string[]
    titled: boolean
    statusRepeated: boolean
    toggleBeforeTyping: boolean
    toggle: string
    toggleBesideSend: boolean
    toggled: string[]
    resumed: boolean
    /** 每条待发行尾“发送”的箭头，和此刻发送键上的箭头（应当同一条路径） */
    sendIcons: string[]
    sendKey: string
  } | null
  /** 本机记下来的那一份（最后点的是排队） */
  saved: string | null
}

export async function sendModeProbe(real: boolean): Promise<SendModeProbe | null> {
  if (real) return null
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
    throw new Error(`发送方式：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const idle = () => until('这一轮结束', () => !running() && !one('.tray-row') && area(), 60_000)
  const write = async (words: string) => {
    const input = await until('输入框', area)
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, words)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await frame()
    return input
  }
  const enter = (input: HTMLTextAreaElement) =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
  // 认准正在跑的那个回合本身，不数对话里画了几个回合：长对话打开后旧回合是分批补画的（turn-window.ts），
  // 慢机器上回合开始之后数目还会涨，数目对不上不等于另起了回合
  const turnOf = (entry: HTMLElement | undefined) => entry?.dataset.searchTurn ?? ''
  const runningTurn = async () =>
    turnOf(await until('回合开始', () => all('.turn').find((entry) => one('.running-line', entry))))
  /** 说的话出现在哪些回合里 */
  const holders = (words: string) =>
    all('.turn')
      .filter((entry) => all('.umsg-text', entry).some((m) => text(m).includes(words)))
      .map(turnOf)
  /** 插进去了：除了发之前就有这句话的回合（had），这句话只出现在那个回合里，那个回合后面没有新回合 */
  const landedIn = (words: string, turn: string, had: string[]) => {
    const found = holders(words).filter((id) => !had.includes(id))
    return found.length === 1 && found[0] === turn && turnOf(all('.turn').at(-1)) === turn
  }
  /** 没插进去时看的：各回合的标识、用户消息、是否在跑 */
  const turnsNow = () =>
    all('.turn').map((entry) => ({
      id: turnOf(entry),
      users: all('.umsg-text', entry).map(text),
      running: Boolean(one('.running-line', entry)),
    }))

  const title = '发版前的检查清单'
  const open = async () => {
    const row = await until(`侧栏里的“${title}”`, () =>
      all('.ss-row:not(.projection-group *)').find((entry) => text(entry).includes(title)),
    )
    row.click()
    await until(`“${title}”的内容`, () => text(one('.crumb')).includes(title) && one('.turn'))
  }
  /** 到设置页“对话”一组点一档，再回到会话 */
  const pick = async (mode: string) => {
    one<HTMLButtonElement>('.sb-settings')?.click()
    await until('设置页', () => one('.set-page'))
    one<HTMLButtonElement>('.set-nav [data-section="chat"]')?.click()
    const button = await until(`“${mode}”那一档`, () =>
      one<HTMLButtonElement>(`[data-choice="sendMode"] [data-value="${mode}"]`),
    )
    button.click()
    await until(`“${mode}”标成选中`, () => button.getAttribute('aria-pressed') === 'true')
    const choices = all('[data-choice="sendMode"] [data-value]').map(
      (entry) => entry.dataset.value ?? '',
    )
    one<HTMLButtonElement>('.set-head .ibtn')?.click()
    await until('关闭设置窗口', () => !one('.page-window'))
    await open()
    return choices
  }

  // ---- 一、立即发送：插进同一个回合，不进托盘 ----
  const choices = await pick('now')
  await idle()
  enter(await write('跑一会儿：先开个头'))
  const target = await runningTurn()
  const steerInput = await write('直接插进去的话')
  const steerHint = steerInput.placeholder
  const steerButton = one('.dock .send')?.getAttribute('title') ?? ''
  const beforeSteer = turnsNow()
  const hadSteer = holders('直接插进去的话')
  const runningAtEnter = running()
  enter(steerInput)
  let trayed = false
  await until('插进去的话出现在对话里', () => {
    trayed ||= Boolean(one('.tray-row'))
    return holders('直接插进去的话').some((id) => !hadSteer.includes(id))
  })
  await frame()
  trayed ||= Boolean(one('.tray-row'))
  const steered = !trayed && landedIn('直接插进去的话', target, hadSteer)
  const steerDetail = JSON.stringify({
    target,
    runningAtEnter,
    trayed,
    holders: holders('直接插进去的话'),
    before: beforeSteer,
    after: turnsNow(),
  })
  await idle()

  // ---- 二、排队：进托盘，点“现在就说”照样插进去 ----
  await pick('queue')
  await idle()
  enter(await write('跑一会儿：再开个头'))
  const queueTurn = await runningTurn()
  const hadQueue = holders('排着的话')
  const queueInput = await write('排着的话')
  const queueHint = queueInput.placeholder
  const queueButton = one('.dock .send')?.getAttribute('title') ?? ''
  enter(queueInput)
  const queued = Boolean(
    await until('托盘里的那一条', () => one('.tray-row'), 5000).catch(() => null),
  )
  const steer = one<HTMLButtonElement>('.tray-row .ibtn.steer')
  const pathOf = (scope: Element | null | undefined) =>
    scope?.querySelector('svg path')?.getAttribute('d') ?? ''
  // 查找栏“上一处”的折线：和它长得一样的就会被看成“上移”。在页面外取不到组件，按路径画一份比
  const chevron = 'M4 10l4-4 4 4'
  const icons = { steer: pathOf(steer), chevron }
  steer?.click()
  const manualSteered = Boolean(
    await until(
      '点“立即插入”之后插进同一个回合',
      () => !one('.tray-row') && landedIn('排着的话', queueTurn, hadQueue),
      10_000,
    ).catch(() => null),
  )
  await idle()

  // ---- 三、停止后的待发 ----
  enter(await write('跑一会儿：停下来'))
  await runningTurn()
  enter(await write('待发的头一句'))
  await until('托盘里的头一句', () => all('.tray-row').length === 1, 5000)
  enter(await write('待发的后一句'))
  await until('托盘里的两句', () => all('.tray-row').length === 2, 5000)
  await write('')
  one<HTMLButtonElement>('.dock .send.stop')?.click()
  let held: SendModeProbe['held'] = null
  const head = await until('待发的头一行', () => one('[data-pending-inputs]'), 10_000).catch(
    () => null,
  )
  if (head) {
    const rows = all('.tray-row')
    const rowHeights = rows.map((row) => Math.round(row.getBoundingClientRect().height))
    const buttons = rows.flatMap((row) => all('.tray-acts button', row))
    const sendIcons = rows.map((row) => pathOf(one('.tray-acts button', row)))
    const sendKey = pathOf(one('.dock .send:not(.stop)'))
    const toggleBeforeTyping = Boolean(one('.cmp-pending'))
    await write('再写一句')
    const toggle = await until('“连同待发”', () => one<HTMLButtonElement>('.cmp-pending'), 5000)
    const send = one('.dock .send')?.getBoundingClientRect()
    const box = toggle.getBoundingClientRect()
    const toggled = [toggle.getAttribute('aria-pressed') ?? '']
    toggle.click()
    await frame()
    toggled.push(one('.cmp-pending')?.getAttribute('aria-pressed') ?? '')
    await write('')
    one<HTMLButtonElement>('[data-pending-inputs] button')?.click()
    const resumed = Boolean(
      await until('全部发送后托盘收起', () => !one('.tray-row'), 10_000).catch(() => null),
    )
    held = {
      head: text(head).replace(/\s+/g, ' '),
      rows: rows.length,
      rowHeights,
      buttons: buttons.map((button) => button.getAttribute('aria-label') ?? ''),
      titled: buttons.every(
        (button) =>
          button.title !== '' &&
          button.title === button.getAttribute('aria-label') &&
          text(button) === '',
      ),
      statusRepeated: rows.some((row) => /已停止|待发送|inputDelivery/.test(text(row))),
      toggleBeforeTyping,
      toggle: text(toggle),
      toggleBesideSend: Boolean(
        send && box.right <= send.left && send.left - box.right <= 12 && box.bottom > send.top,
      ),
      toggled,
      resumed,
      sendIcons,
      sendKey,
    }
    await idle()
  }
  let saved: string | null = null
  try {
    saved = localStorage.getItem('litch.compose')
  } catch {
    saved = null
  }
  return {
    choices,
    steerHint,
    steerButton,
    steered,
    steerDetail,
    queueHint,
    queueButton,
    queued,
    manualSteered,
    icons,
    held,
    saved,
  }
}

export function judgeSendMode(probe: SendModeProbe | null): string[] {
  if (!probe) return []
  const failed: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  check(
    probe.choices.join(',') === 'now,queue',
    `设置页“对话”里的档不对：${probe.choices.join(',')}`,
  )
  check(probe.steerHint.includes('直接插入'), `立即发送时的提示不对：“${probe.steerHint}”`)
  check(probe.steerButton === '发送', `立即发送时按钮上写的是“${probe.steerButton}”`)
  check(
    probe.steered,
    `立即发送：回合进行中发的消息没有直接插进同一个回合（进了托盘或者另起了回合）：${probe.steerDetail}`,
  )
  check(probe.queueHint.includes('排队'), `排队时的提示不对：“${probe.queueHint}”`)
  check(probe.queueButton === '排队', `排队时按钮上写的是“${probe.queueButton}”`)
  check(probe.queued, '排队：回合进行中发的消息没有进托盘')
  check(probe.manualSteered, '排队：托盘里点“现在就说”没有插进同一个回合')
  const icons = probe.icons
  const sendArrow = probe.held?.sendKey ?? ''
  check(
    icons.steer !== '' &&
      sendArrow !== '' &&
      icons.steer !== sendArrow &&
      icons.steer !== icons.chevron,
    `“立即插入”的图标和发送箭头或查找栏的折线一样：${JSON.stringify({ ...icons, sendArrow })}`,
  )
  const held = probe.held
  check(Boolean(held), '停止后没有出现待发的头一行')
  if (held) {
    const said = JSON.stringify(held)
    check(/^2 条待发\s*·\s*全部发送$/.test(held.head), `待发的头一行不对：${said}`)
    check(
      held.rows === 2 && held.rowHeights.every((h) => h > 0 && h <= 30),
      `待发每条不是一行：${said}`,
    )
    check(
      held.buttons.join(',') === '发送,编辑,移除,发送,编辑,移除',
      `待发行尾的图标按钮不对：${said}`,
    )
    check(held.titled, `待发的图标按钮缺悬停提示或读屏名称，或者写了字：${said}`)
    check(!held.statusRepeated, `待发的每行又写了一遍状态：${said}`)
    check(!held.toggleBeforeTyping, `输入框没字时就出现了“连同待发”：${said}`)
    check(held.toggle === '含 2 条待发' && held.toggleBesideSend, `“连同待发”不在发送键旁：${said}`)
    check(held.toggled.join(',') === 'true,false', `“连同待发”点了没有换档：${said}`)
    check(held.resumed, `点“全部发送”后托盘没有收起：${said}`)
    check(
      held.sendKey !== '' &&
        held.sendKey !== icons.chevron &&
        held.sendIcons.length === 2 &&
        held.sendIcons.every((icon) => icon === held.sendKey),
      `待发行的“发送”和发送键不是同一个箭头：${said}`,
    )
  }
  check(probe.saved === '{"mode":"queue"}', `本机记下来的不对：${probe.saved}`)
  return failed
}
