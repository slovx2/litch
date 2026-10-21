// 会话操作的验收：拒绝审批时附说明、归档之后的撤销、会话行的右键菜单、只读地看已归档的对话、
// 待办进度、分叉、回退重发、压缩上下文。跟在输入区那一组（probe-compose.mts）后面，在同一个窗口里接着量。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
// 隔离入口里的 Pi 引擎不发审批、也不发待办更新，那两项只对着模拟核心量；“对面不会的事要降级”也只有
// 模拟核心里有不会的引擎。分叉、回退、压缩两边都量：真实入口上压缩的请求发得出去，但那里的会话太小，
// Pi 不压：不开回合，请求的错误是它的原话，客户端出一条“没压缩成”的提示；“上下文已压缩”那一行
// 只在模拟核心上看得到。

export interface SessionProbe {
  /** 拒绝时附说明。只在模拟核心上量 */
  declineNote: {
    /** 能带说明的“拒绝”旁边有“拒绝并说明”，点开之后焦点在输入框里 */
    offered: boolean
    focused: boolean
    /** 输入法还在选词时按回车：不发，卡片还在 */
    imeKept: boolean
    /** 在输入框里按 Esc 只收起输入框，不算拒绝；焦点回到卡片上 */
    escKept: boolean
    /** 什么都没写时按回车不发 */
    emptyKept: boolean
    /** 写了说明按回车：卡片消失，对面听到了那句话，那条命令标成已拒绝 */
    heard: boolean
    declined: boolean
  } | null
  /** 会话行的右键菜单 */
  contextMenu: {
    /** 在行上点右键：出的是行尾“更多”那一份（置顶、移到项目、改名、归档、删除），弹在鼠标那里，系统自己的菜单没出来 */
    opened: boolean
    atPointer: boolean
    /** 焦点落在菜单里，Esc 收起 */
    focused: boolean
    closed: boolean
    /** 鼠标在窗口右下角时，整块菜单还在窗口里 */
    clamped: boolean
  }
  /** 归档之后的撤销 */
  undo: {
    /** 从右键菜单里归档：这一行没了，出一条提示，上面有标题和“撤销” */
    offered: boolean
    /** 鼠标在提示上面时过了时间也不消失；移开之后自己消失。只在模拟核心上量（要等十几秒） */
    heldWhileHovered: boolean | null
    goneAfterLeave: boolean | null
    /** 提示还在的时候，那个会话在“已归档对话”里被恢复了：提示跟着收起，不留一个撤销不了的按钮 */
    prunedElsewhere: boolean | null
    /** 连着归档两个：还是一条提示，说的是两个；“全部撤销”把两个都恢复。只在模拟核心上量 */
    merged: boolean | null
    mergedRestored: boolean | null
    /** 归档正开着的那个会话再撤销：它回到侧栏里，并且重新选中 */
    restored: boolean
    reselected: boolean
  }
  /** 不恢复就看已归档的对话 */
  peek: {
    /** 在“已归档对话”里点标题：看到了它的内容，标题栏上是它的名字和“已归档” */
    opened: boolean
    /** 只读：没有输入框，原来的位置上是一条写着“已归档”的栏，上面有“恢复” */
    readOnly: boolean
    /** 只是看：它没有因此回到侧栏里 */
    stillShelved: boolean
    /** Esc 回到列表，列表里还有它 */
    escBack: boolean
    /** 点“恢复”：落回平常的对话区，侧栏里选中的是它，能发消息并收到回答 */
    restored: boolean
    canSend: boolean
    /** 恢复之后，归档时出的那条“撤销”提示跟着收起 */
    toastGone: boolean
  }
  /** 待办进度。只在模拟核心上量（隔离入口里的引擎不发待办更新） */
  todo: {
    /** 回合里出了一张待办卡片：四步，第一步正在做，标题上写着做完几步、正在做第几步 */
    shown: boolean
    /** 做完一步：还是原来那张卡片（页面元素没换），第一步打了勾，第二步正在做 */
    advanced: boolean
    /** 做到一半多了一步：还是那张卡片，变成五步 */
    grew: boolean
    /** 回合结束之后卡片留在对话里，五步都做完了，不再有“正在做” */
    kept: boolean
    /** 步骤的行高是整数像素 */
    wholeLines: boolean
    /** 切到别的会话再回来，卡片还在 */
    reopened: boolean
    /** 做到一半打断：卡片留着，没做完的那一步不再标成“正在做” */
    interrupted: boolean
  } | null
  /** 从自己发过的一条消息分叉成新会话 */
  fork: {
    /** 消息上的两个操作平时看不见、不占位置，键盘焦点进来就出现 */
    hidden: boolean
    revealed: boolean
    /** 点“分叉”：落到一个新会话里，侧栏里多了一行，新会话里有这条消息、没有它后面的 */
    opened: boolean
    cut: boolean
    /** 出了一句“已经分叉”的提示 */
    told: boolean
    /** 新会话里能接着发消息 */
    canSend: boolean
    /** 新会话最上面一行写着它分叉自原来的会话（名字可以点） */
    marked: boolean
    /** 点那一行里的名字回到原来的会话；原来的会话不是分出来的，没有这一行 */
    wentBack: boolean
    /** 原来的会话没动：后面那条还在，也没有多出新会话里说的话 */
    sourceKept: boolean
  }
  /** 回退到一条消息之前，改了重发 */
  rollback: {
    /** 点“回退”先问一次，说了找不回来、文件不还原；焦点在“取消”上 */
    asked: boolean
    /** 取消：什么都没动 */
    cancelKept: boolean
    /** 确认：这条消息和它后面的都没了，前面的还在 */
    removed: boolean
    /** 这条消息的字回到输入框，排在已经写了一半的字前面，焦点在输入框里 */
    refilled: boolean
    /** 切走再回来（真实入口上是重新向设备取一遍）：撤掉的没有回来 */
    stayedGone: boolean
    /** 回退之后照常能发 */
    resent: boolean
  }
  /** 手动压缩上下文 */
  compact: {
    /** 圆环点开有“压缩上下文” */
    offered: boolean
    /**
     * 点了之后有了下文：多出一个回合，并且结束了；
     * 真实入口上 Pi 嫌会话太小不压时，是没多出回合、出了一条“没压缩成”的提示（原因记在 refused）
     */
    ran: boolean
    /** 真实入口上没压时，提示里说的原因（“没压缩成：”后面那段）。压了的是 null */
    refused: string | null
    /** 那个回合里留下了“上下文已压缩”，直接看得见。只在模拟核心上判 */
    noted: boolean | null
    /** 真实入口上有没有留下这一行：那里的假模型不一定压得成，只记不判 */
    notedOnEntry: boolean | null
    /** 真实入口上压缩的那个回合里写了什么，只记不判 */
    entrySaid: string | null
    /** 占用降下来了。只在模拟核心上量 */
    dropped: boolean | null
    /** 回合进行中：压缩和分叉的入口都停着，上面写着为什么。只在模拟核心上量 */
    busyBlocked: boolean | null
  }
  /** 对面不会的事：试过一次，入口停掉，说一句人话。只在模拟核心上量 */
  degrade: {
    /** 试之前入口是开着的 */
    openBefore: boolean
    /** 点了分叉：出错的提示里说了不支持，按钮停了，上面写着为什么 */
    forkStopped: boolean
    /** 压缩同样 */
    compactStopped: boolean
    /** 这种引擎会的事（回退）不受影响 */
    othersKept: boolean
    /** 别的引擎的会话不受影响 */
    elsewhereKept: boolean
  } | null
}

export async function sessionProbe(real: boolean): Promise<SessionProbe> {
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
    throw new Error(`等不到：${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string) =>
    document.querySelector<E>(selector)
  const all = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
  const area = () => one<HTMLTextAreaElement>('textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const open = async (title: string) => {
    const row = await until(`侧栏里的“${title}”`, () =>
      all('.ss-row').find((element) => element.textContent?.includes(title)),
    )
    row.click()
    await until(
      `“${title}”的内容`,
      () => one('.crumb')?.textContent?.includes(title) && one('.turn'),
    )
    await frame()
  }
  /** 往受控的输入框里写字：直接赋值界面不知道，要走原生的设值再发一个输入事件 */
  const write = (target: HTMLTextAreaElement | HTMLInputElement, text: string) => {
    const proto =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, text)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: Element, key: string, init: KeyboardEventInit = {}) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }),
    )
  /** 在输入框里写一句话，按回车 */
  const say = async (text: string) => {
    const input = await until('输入框', area)
    write(input, text)
    await frame()
    press(input, 'Enter')
    await frame()
  }

  const main = real ? '给首页加一个状态条' : '首页文案'

  // ---- 一、拒绝审批时附说明（模拟核心里话里带“审批”，回合会停下来要一次审批） ----
  let declineNote: SessionProbe['declineNote'] = null
  if (!real) {
    await open(main)
    await say('跑一条要审批的命令')
    const card = await until('审批卡片', () => one<HTMLElement>('.req'))
    await frame()
    const noteField = () => one<HTMLInputElement>('.req-note .req-input')
    const opener = () => card.querySelector<HTMLButtonElement>('.note-open')
    const offered = Boolean(opener())
    opener()?.click()
    const field = await until('说明的输入框', noteField)
    await frame()
    const focused = document.activeElement === field
    write(field, '还在选词')
    await frame()
    press(field, 'Enter', { isComposing: true })
    await sleep(150)
    const imeKept = one('.req') === card && field.isConnected
    press(field, 'Escape')
    await until('说明的输入框收起', () => !noteField())
    await sleep(150)
    const escKept = one('.req') === card && document.activeElement === card
    opener()?.click()
    const again = await until('再点开的输入框', noteField)
    await frame()
    press(again, 'Enter')
    await sleep(150)
    const emptyKept = one('.req') === card
    const why = '先别联网，用本地的缓存'
    write(again, why)
    await frame()
    press(again, 'Enter')
    await until('审批卡片消失', () => !one('.req'))
    const turn = () => all('.turn').at(-1)
    const heard = Boolean(await until('对面听到了说明', () => turn()?.textContent?.includes(why)))
    const declined = Boolean(
      // 命令收在步骤组里时，组的汇总行（或回合结束后整段过程那一行）上写“N 条被拒”
      await until('那条命令标成已拒绝', () => /已拒绝|\d+ 条被拒/.test(turn()?.textContent ?? '')),
    )
    await until('这个回合结束', () => !running() && area(), 60_000)
    declineNote = { offered, focused, imeKept, escKept, emptyKept, heard, declined }
  }

  // ---- 二、会话行的右键菜单 ----
  const other = real ? '连接层的重连与对账' : '远程设备安装指引'
  const rowOf = (title: string) =>
    all('.ss-row').find((element) => element.textContent?.includes(title))
  const menu = () => one('.row-more .pick-pop.at')
  /** 在某一行上点右键。返回页面有没有拦下系统自己的菜单 */
  const rightClick = (title: string, x?: number, y?: number) => {
    const row = rowOf(title)
    if (!row) throw new Error(`侧栏里没有“${title}”`)
    const box = row.getBoundingClientRect()
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: x ?? box.left + 60,
      clientY: y ?? box.top + box.height / 2,
    })
    return { handled: !row.dispatchEvent(event), x: event.clientX, y: event.clientY }
  }
  /** 从右键菜单里选一项 */
  const pickFromMenu = async (title: string, item: string) => {
    rightClick(title)
    const entry = await until(`右键菜单里的“${item}”`, () =>
      [...(menu()?.querySelectorAll<HTMLElement>('.pick-opt') ?? [])].find((element) =>
        element.textContent?.includes(item),
      ),
    )
    entry.click()
    await frame()
  }
  await until(`侧栏里的“${other}”`, () => rowOf(other))
  // 回合结束时整段过程收起，对话区随后还要滚一下把位置对上；弹在鼠标处的菜单碰上滚动就收起，等停稳了再点右键
  let moved = performance.now()
  const mark = () => {
    moved = performance.now()
  }
  window.addEventListener('scroll', mark, true)
  await until('页面停止滚动', () => performance.now() - moved > 300)
  window.removeEventListener('scroll', mark, true)
  const click = rightClick(other)
  const popped = await until('右键菜单', menu)
  await frame()
  const names = [...popped.querySelectorAll('.pick-opt')].map((entry) => entry.textContent)
  const spot = popped.getBoundingClientRect()
  // 末尾三项总是这三样。设备上能整理侧栏的话前面多出“置顶”“移到组…”和“移到项目…”：
  // 模拟核心里一定有；真实入口上看对面有没有这组方法、有没有别的项目。
  // 设备声明了会话树的话还有“派一个子会话…”，支持定时任务的话还有“为这个会话建定时任务”
  // （模拟核心的本机两样都声明了；真实入口看对面）
  const spawnable = names.includes('派一个子会话…')
  const schedulable = names.includes('为这个会话建定时任务')
  const organizing = names
    .slice(0, -3)
    .filter((name) => name !== '派一个子会话…' && name !== '为这个会话建定时任务')
    .join('|')
  const contextMenu: SessionProbe['contextMenu'] = {
    opened:
      click.handled &&
      names.slice(-3).join('|') === '改名|归档|删除' &&
      (real || (spawnable && schedulable)) &&
      (real
        ? ['', '置顶|移到组…', '置顶|移到组…|移到项目…'].includes(organizing)
        : organizing === '置顶|移到组…|移到项目…'),
    atPointer: Math.abs(spot.left - click.x) < 2 && Math.abs(spot.top - click.y) < 2,
    focused: popped.contains(document.activeElement),
    closed: false,
    clamped: false,
  }
  press(document.activeElement ?? popped, 'Escape')
  await until('右键菜单收起', () => !menu())
  contextMenu.closed = true
  rightClick(other, window.innerWidth - 3, window.innerHeight - 3)
  const cornered = await until('窗口右下角的右键菜单', menu)
  await frame()
  await frame()
  const edge = cornered.getBoundingClientRect()
  contextMenu.clamped = edge.right <= window.innerWidth && edge.bottom <= window.innerHeight
  press(document.activeElement ?? cornered, 'Escape')
  await until('右键菜单收起', () => !menu())

  // ---- 三、归档之后的撤销 ----
  const toast = () => one('.toast[data-toast="archived"]')
  const undoButton = () => toast()?.querySelector<HTMLButtonElement>('.toast-act')
  await pickFromMenu(other, '归档')
  await until('归档的那一行消失', () => !rowOf(other))
  const offer = await until('可以撤销的提示', toast)
  const undo: SessionProbe['undo'] = {
    offered: Boolean(offer.textContent?.includes(other)) && undoButton()?.textContent === '撤销',
    heldWhileHovered: null,
    goneAfterLeave: null,
    prunedElsewhere: null,
    merged: null,
    mergedRestored: null,
    restored: false,
    reselected: false,
  }
  if (!real) {
    // 鼠标停在上面：过了该消失的时间还在；移开之后才开始计时
    offer.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    await sleep(7000)
    undo.heldWhileHovered = toast() === offer
    offer.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    const leftAt = performance.now()
    await until('提示自己消失', () => !toast(), 9000)
    undo.goneAfterLeave = performance.now() - leftAt > 4000
    // 上面那个已经过了能撤销的时候，从“已归档对话”里放回来
    const restoreFromPage = async () => {
      one<HTMLButtonElement>('.sb-settings')?.click()
      ;(
        await until('设置页上进已归档对话的入口', () =>
          one<HTMLButtonElement>('.set-go[data-page="archived"]'),
        )
      ).click()
      const shelved = await until('已归档对话里的这个会话', () =>
        all('.arch-item').find((element) => element.textContent?.includes(other)),
      )
      ;[...shelved.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('恢复'))
        ?.click()
      await until('恢复的会话回到侧栏里', () => rowOf(other))
    }
    await restoreFromPage()
    // 再归档一次，这回趁提示还在就从那一页里恢复：提示应该跟着没了
    await pickFromMenu(other, '归档')
    await until('归档的那一行消失', () => !rowOf(other) && toast())
    await restoreFromPage()
    undo.prunedElsewhere = Boolean(await until('提示跟着收起', () => !toast(), 2000))

    // 连着归档两个：并成一条
    const second = '能力矩阵页改成从声明生成'
    await pickFromMenu(other, '归档')
    await until('第一个归档完', () => !rowOf(other) && toast())
    await pickFromMenu(second, '归档')
    await until('第二个归档完', () => !rowOf(second))
    await until('提示说的是两个', () => toast()?.textContent?.includes('2'))
    undo.merged = all('.toast').length === 1 && undoButton()?.textContent === '全部撤销'
    undoButton()?.click()
    await until('两个都回到侧栏里', () => rowOf(other) && rowOf(second))
    undo.mergedRestored = !toast()
  } else {
    undoButton()?.click()
    await until('撤销之后回到侧栏里', () => rowOf(other))
  }

  // 归档正开着的那个：撤销之后回到它
  await open(other)
  rowOf(other)?.parentElement?.querySelector<HTMLButtonElement>('.row-more > .ibtn')?.click()
  const shelve = await until('行尾菜单里的“归档”', () =>
    all('.row-more .pick-opt').find((element) => element.textContent?.includes('归档')),
  )
  shelve.click()
  await until('归档的那一行消失', () => !rowOf(other))
  await until('可以撤销的提示', undoButton).then((button) => button.click())
  await until('撤销之后回到侧栏里', () => rowOf(other))
  undo.restored = !toast()
  undo.reselected = Boolean(
    await until(
      '撤销之后重新选中它',
      () => rowOf(other)?.classList.contains('sel') && one('.crumb')?.textContent?.includes(other),
    ),
  )

  // ---- 四、不恢复就看已归档的对话 ----
  await pickFromMenu(other, '归档')
  await until('归档的那一行消失', () => !rowOf(other) && toast())
  one<HTMLButtonElement>('.sb-settings')?.click()
  ;(
    await until('设置页上进已归档对话的入口', () =>
      one<HTMLButtonElement>('.set-go[data-page="archived"]'),
    )
  ).click()
  const opener = () =>
    all('.arch-item')
      .find((element) => element.textContent?.includes(other))
      ?.querySelector<HTMLButtonElement>('.arch-open')
  const bar = () => one('.arch-bar')
  ;(await until('已归档对话里它的标题', opener)).click()
  await until('已归档的对话的内容', () => bar() && one('.turn'))
  await frame()
  const crumb = () => one('.crumb')?.textContent ?? ''
  const peek: SessionProbe['peek'] = {
    opened:
      crumb().includes(other) && Boolean(one('.crumb .pill')?.textContent?.includes('已归档')),
    readOnly:
      !area() &&
      !one('.cmp-text') &&
      Boolean(bar()?.textContent?.includes('已归档')) &&
      [...(bar()?.querySelectorAll('button') ?? [])].some(
        (button) => button.textContent === '恢复',
      ),
    stillShelved: !rowOf(other),
    escBack: false,
    restored: false,
    canSend: false,
    toastGone: false,
  }
  press(document.activeElement ?? document.body, 'Escape')
  await until('回到已归档对话的列表', () => !bar() && opener())
  peek.escBack = crumb().includes('已归档对话')
  ;(await until('已归档对话里它的标题', opener)).click()
  const restoreButton = await until('“恢复”', () =>
    [...(bar()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent === '恢复' && !button.disabled,
    ),
  )
  await until('已归档的对话的内容', () => one('.turn'))
  restoreButton.click()
  await until('恢复之后落回平常的对话区', () => !bar() && area() && rowOf(other))
  await frame()
  peek.restored =
    Boolean(rowOf(other)?.classList.contains('sel')) &&
    crumb().includes(other) &&
    !one('.crumb .pill')
  peek.toastGone = !toast()
  const before = all('.turn').length
  const word = '恢复之后接着聊'
  await say(word)
  await until('恢复之后发出去的那一轮', () => all('.turn').length > before)
  await until('这一轮结束', () => !running() && area(), 60_000)
  const last = all('.turn').at(-1)?.textContent ?? ''
  peek.canSend = last.includes(word) && (real ? last.includes(`收到：${word}`) : true)

  // ---- 五、待办进度（模拟核心里话里带“待办”，回合会先列一份待办，一步一步做完） ----
  let todo: SessionProbe['todo'] = null
  if (!real) {
    await open(main)
    // 窗口够宽时待办在右边常驻的信息栏里（对话里不再画），否则在回合里
    const card = () =>
      one<HTMLElement>('.rail-todo') ?? all('.turn').at(-1)?.querySelector<HTMLElement>('.todo')
    const count = () => card()?.querySelector('.todo-count')?.textContent ?? ''
    const steps = () => [...(card()?.querySelectorAll<HTMLElement>('.todo-step') ?? [])]
    /** 信息栏里全做完的待办默认收着：点开再看 */
    const expand = async () => {
      const shown = card()
      if (!shown?.classList.contains('rail-todo') || shown.hasAttribute('data-open')) return
      shown.querySelector<HTMLButtonElement>('.rail-head')?.click()
      await frame()
    }
    /** 正在做第几项：对话里的卡片写在标题行上，信息栏里看清单里哪一步在做；没有在做的是 0 */
    const now = () => {
      const label = card()?.querySelector('.todo-now')?.textContent
      if (label) return Number(label.match(/\d+/)?.[0] ?? 0)
      return steps().findIndex((step) => step.classList.contains('inProgress')) + 1
    }
    const is = (index: number, status: string) =>
      steps()[index]?.classList.contains(status) === true
    const turnsBefore = all('.turn').length
    await say('列一份待办再动手')
    await until('新的一轮', () => all('.turn').length > turnsBefore)
    // 信息栏里可能还留着上一份待办：等到这一份（0/4）出来
    const first = await until('待办卡片', () => (count().includes('0/4') ? card() : null))
    const shown =
      steps().length === 4 &&
      count().includes('0/4') &&
      is(0, 'inProgress') &&
      is(1, 'pending') &&
      now() === 1
    await until('做完第一步', () => count().includes('1/4'))
    const advanced = card() === first && is(0, 'completed') && is(1, 'inProgress')
    await until('多了一步', () => steps().length === 5)
    const grew = card() === first && count().includes('/5')
    await until('全做完', () => count().includes('5/5'))
    await until('这一轮结束', () => !running() && area(), 60_000)
    await expand()
    const kept =
      card() === first &&
      steps().length === 5 &&
      steps().every((step) => step.classList.contains('completed')) &&
      now() === 0
    const wholeLines = steps().every((step) => {
      const height = Number.parseFloat(getComputedStyle(step).lineHeight)
      return height > 0 && Number.isInteger(height)
    })
    await open(other)
    await open(main)
    await expand()
    const reopened = steps().length === 5 && count().includes('5/5')
    // 再来一次，做到一半打断
    await say('todo again')
    await until('第二份待办做完第一步', () => count().includes('1/4'))
    ;(await until('停止按钮', () => one<HTMLButtonElement>('.send.stop'))).click()
    await until('被打断的回合停下来', () => !running() && area())
    await frame()
    await expand()
    const interrupted =
      count().includes('1/4') &&
      steps().length === 4 &&
      !card()?.querySelector('.inProgress') &&
      now() === 0
    todo = { shown, advanced, grew, kept, wholeLines, reopened, interrupted }
  }

  // ---- 六、从一条消息分叉 ----
  await open(main)
  const bubbles = () => all('.umsg')
  const bubble = (text: string) => bubbles().find((element) => element.textContent?.includes(text))
  const turns = () => all('.turn').length
  /** 发一句话，等这一轮结束 */
  const sayAndWait = async (text: string) => {
    const before = turns()
    await say(text)
    await until(`“${text}”这一轮`, () => turns() > before && bubble(text))
    await until('这一轮结束', () => !running() && area(), 60_000)
    await frame()
  }
  const act = (text: string, kind: 'fork' | 'rollback') =>
    bubble(text)?.querySelector<HTMLButtonElement>(`.act-${kind}`) ?? null
  const actionToast = () => one('.toast[data-toast="turn-action"]')
  const mainRows = () => all('.ss-row').filter((element) => element.textContent?.includes(main))
  const earlier = '分叉从这一句开始'
  const later = '这一句不该进新会话'
  await sayAndWait(earlier)
  await sayAndWait(later)
  const acts = bubble(earlier)?.querySelector<HTMLElement>('.umsg-acts')
  const rowsBefore = mainRows().length
  const turnsBefore = turns()
  const fork: SessionProbe['fork'] = {
    hidden:
      Boolean(acts) &&
      getComputedStyle(acts as HTMLElement).opacity === '0' &&
      getComputedStyle(acts as HTMLElement).position === 'absolute',
    revealed: false,
    opened: false,
    cut: false,
    told: false,
    canSend: false,
    marked: false,
    wentBack: false,
    sourceKept: false,
  }
  act(earlier, 'fork')?.focus()
  fork.revealed = Boolean(
    await until('操作出现', () => acts && getComputedStyle(acts).opacity === '1', 3000),
  )
  act(earlier, 'fork')?.click()
  await until('落到分叉出来的会话里', () => mainRows().length === rowsBefore + 1)
  await until('新会话的内容', () => turns() === turnsBefore - 1 && bubble(earlier))
  await frame()
  fork.opened =
    Boolean(one('.ss-row.sel')?.textContent?.includes(main)) &&
    Boolean(one('.crumb')?.textContent?.includes(main))
  fork.cut = Boolean(bubble(earlier)) && !bubble(later)
  fork.told = Boolean(actionToast()?.textContent?.includes('分叉'))
  // 只认分叉来源那一条（data-source）：定时任务的说明条、会话树的父会话条也借用 forked-from 的样子
  const backLink = () => one<HTMLButtonElement>('.forked-from[data-source] .forked-link')
  fork.marked = Boolean(backLink()?.textContent?.includes(main))
  const aside = '在岔出来的会话里说'
  await sayAndWait(aside)
  fork.canSend =
    Boolean(bubble(aside)) &&
    (real ? Boolean(all('.turn').at(-1)?.textContent?.includes(`收到：${aside}`)) : true)
  // 回到原来那个：点新会话最上面那一行里的名字；没有那一行就点侧栏里同名的两行里没选中的那一行
  const back = backLink()
  if (back) back.click()
  else
    mainRows()
      .find((element) => !element.classList.contains('sel'))
      ?.click()
  await until('原来的会话', () => bubble(later))
  await frame()
  fork.wentBack = Boolean(back) && !one('.forked-from[data-source]')
  fork.sourceKept = turns() === turnsBefore && !bubble(aside)

  // ---- 七、回退到一条消息之前，改了重发 ----
  const confirm = () => one<HTMLDialogElement>('dialog.confirm[open]')
  const half = '写了一半的话'
  write(await until('输入框', area), half)
  await frame()
  act(later, 'rollback')?.click()
  const asking = await until('回退前的确认', confirm)
  await frame()
  const rollback: SessionProbe['rollback'] = {
    asked:
      Boolean(asking.textContent?.includes('找不回来')) &&
      Boolean(asking.textContent?.includes('不会还原')) &&
      document.activeElement?.textContent === '取消',
    cancelKept: false,
    removed: false,
    refilled: false,
    stayedGone: false,
    resent: false,
  }
  ;(document.activeElement as HTMLElement | null)?.click()
  await until('确认收起', () => !confirm())
  await sleep(150)
  rollback.cancelKept = turns() === turnsBefore && Boolean(bubble(later))
  act(later, 'rollback')?.click()
  ;(await until('回退前的确认', confirm)).querySelector<HTMLButtonElement>('.confirm-yes')?.click()
  await until('这条消息被撤掉', () => !bubble(later))
  await until('消息的字回到输入框', () => area()?.value.includes(later), 5000)
  await frame()
  await frame()
  rollback.removed = turns() === turnsBefore - 1 && Boolean(bubble(earlier))
  rollback.refilled = area()?.value === `${later}\n\n${half}` && document.activeElement === area()
  write(area() as HTMLTextAreaElement, '')
  await frame()
  await open(other)
  await open(main)
  rollback.stayedGone = turns() === turnsBefore - 1 && !bubble(later) && Boolean(bubble(earlier))
  const again = '回退之后重发'
  await sayAndWait(again)
  rollback.resent =
    turns() === turnsBefore &&
    (real ? Boolean(all('.turn').at(-1)?.textContent?.includes(`收到：${again}`)) : true)

  // ---- 八、手动压缩上下文 ----
  const meter = () => one<HTMLButtonElement>('.ctx-btn')
  const compactEntry = () => one<HTMLButtonElement>('.ctx-pop .ctx-compact')
  const percent = () => Number.parseInt(meter()?.textContent ?? '', 10)
  const usedBefore = percent()
  const turnsNow = turns()
  ;(await until('上下文圆环', meter)).click()
  const entry = await until('“压缩上下文”', compactEntry)
  const compact: SessionProbe['compact'] = {
    offered:
      Boolean(entry.textContent?.includes('压缩上下文')) &&
      entry.getAttribute('aria-disabled') !== 'true',
    ran: false,
    refused: null,
    noted: null,
    notedOnEntry: null,
    entrySaid: null,
    dropped: null,
    busyBlocked: null,
  }
  // 没压成时界面出的那条提示（ContextMeter 里的 compact-failed）
  const refusal = () => one('[data-toast="compact-failed"] .toast-text')?.textContent ?? ''
  entry.click()
  await until(
    '压缩的那个回合，或者没压成的提示',
    () => turns() > turnsNow || (real && refusal()),
    20_000,
  )
  const told = refusal()
  if (real && told && turns() === turnsNow) {
    // Pi 不压：提示是“没压缩成：”加上原因，原因是对面的原话。这里不写死它，
    // judgeSession 只看它是不是界面自己的套话。再等一会儿，确认后面也没有冒出回合来
    await sleep(1_500)
    compact.refused = told.startsWith('没压缩成：') ? told.slice('没压缩成：'.length).trim() : ''
    compact.ran = turns() === turnsNow && !one('.ctx-pop')
    one<HTMLButtonElement>('[data-toast="compact-failed"] .toast-x')?.click()
  } else {
    await until('压缩结束', () => !running() && area(), 60_000)
    await frame()
    compact.ran = turns() === turnsNow + 1 && !one('.ctx-pop')
  }
  const noted = Boolean(all('.turn').at(-1)?.textContent?.includes('上下文已压缩'))
  if (real && compact.refused === null) {
    compact.notedOnEntry = noted
    compact.entrySaid = all('.turn').at(-1)?.textContent?.slice(0, 160) ?? null
  } else if (!real) {
    compact.noted = noted
  }
  if (!real) {
    compact.dropped = percent() < usedBefore
    // 回合进行中：两个入口都停着
    await say('再说一句长的')
    await until('回合开始', running)
    ;(await until('上下文圆环', meter)).click()
    const stopped = await until('“压缩上下文”', compactEntry)
    compact.busyBlocked =
      stopped.getAttribute('aria-disabled') === 'true' &&
      Boolean(stopped.textContent?.includes('回合还在进行')) &&
      act(earlier, 'fork')?.getAttribute('aria-disabled') === 'true'
    press(stopped, 'Escape')
    await until('浮层收起', () => !one('.ctx-pop'))
    await until('这一轮结束', () => !running() && area(), 60_000)
  }

  // ---- 九、对面不会的事 ----
  // 模拟核心里那台只有原生 codex 的设备：它没有声明，会什么试了才知道，而且它不会分叉和压缩。
  // （有声明的 harness 不走这条路：不会的入口一开始就不出，那在完整模式的验收里量）
  let degrade: SessionProbe['degrade'] = null
  if (!real) {
    await open('整理快照保留策略')
    const forkButton = () => one<HTMLButtonElement>('.umsg .act-fork')
    const off = (element: Element | null | undefined) =>
      element?.getAttribute('aria-disabled') === 'true'
    const failed = () => one('.toast.err')?.textContent ?? ''
    const openBefore = Boolean(await until('消息上的分叉按钮', forkButton)) && !off(forkButton())
    forkButton()?.click()
    await until('说不支持的提示', () => failed().includes('不支持'))
    await until('分叉按钮停掉', () => off(forkButton()))
    const forkStopped =
      failed().includes('没分叉成') && Boolean(forkButton()?.title.includes('不支持'))
    one<HTMLButtonElement>('.toast.err .toast-x')?.click()
    await until('提示关掉', () => !one('.toast.err'))
    ;(await until('上下文圆环', meter)).click()
    ;(await until('“压缩上下文”', compactEntry)).click()
    await until(
      '说不支持的提示',
      () => failed().includes('没压缩成') && failed().includes('不支持'),
    )
    ;(await until('上下文圆环', meter)).click()
    const compactStopped =
      off(await until('“压缩上下文”', compactEntry)) &&
      Boolean(compactEntry()?.textContent?.includes('不支持'))
    press(compactEntry() as HTMLElement, 'Escape')
    await until('浮层收起', () => !one('.ctx-pop'))
    const othersKept = !off(one('.umsg .act-rollback'))
    one<HTMLButtonElement>('.toast.err .toast-x')?.click()
    await open(main)
    const elsewhereKept = !off(act(earlier, 'fork'))
    degrade = { openBefore, forkStopped, compactStopped, othersKept, elsewhereKept }
  }

  return { declineNote, contextMenu, undo, peek, todo, fork, rollback, compact, degrade }
}

/** 界面在说不出具体原因时自己用的几句话（packages/ui 的 error.*、ability.unsupported） */
const GENERIC_REASONS = ['出了点问题', '设备没有', '已取消', '不支持这个操作']

/** 哪些项不合格。全过就是空的 */
export function judgeSession(probe: SessionProbe): string[] {
  const failed: string[] = []
  for (const [name, ok] of Object.entries(probe.declineNote ?? {})) {
    if (!ok) failed.push(`拒绝时附说明：${name} 不对`)
  }
  for (const [name, ok] of Object.entries(probe.contextMenu)) {
    if (!ok) failed.push(`会话行的右键菜单：${name} 不对`)
  }
  for (const [name, ok] of Object.entries(probe.undo)) {
    if (ok === false) failed.push(`归档之后的撤销：${name} 不对`)
  }
  for (const [name, ok] of Object.entries(probe.peek)) {
    if (!ok) failed.push(`看已归档的对话：${name} 不对`)
  }
  for (const [name, ok] of Object.entries(probe.todo ?? {})) {
    if (!ok) failed.push(`待办进度：${name} 不对`)
  }
  for (const [name, ok] of Object.entries(probe.fork)) {
    if (!ok) failed.push(`分叉：${name} 不对`)
  }
  for (const [name, ok] of Object.entries(probe.rollback)) {
    if (!ok) failed.push(`回退：${name} 不对`)
  }
  for (const [name, ok] of Object.entries(probe.compact)) {
    // 真实入口上的假模型不一定压得成，那两项只记不判
    if (ok === false && name !== 'notedOnEntry') failed.push(`压缩上下文：${name} 不对`)
  }
  // 没压的时候，用户得看到对面说的为什么：不是空的，也不是界面自己的套话
  const reason = probe.compact.refused
  if (reason !== null && (!reason || GENERIC_REASONS.some((phrase) => reason.includes(phrase)))) {
    failed.push(`压缩上下文：没压的提示里没有对面给的原因（“${reason}”）`)
  }
  for (const [name, ok] of Object.entries(probe.degrade ?? {})) {
    if (!ok) failed.push(`不支持时的降级：${name} 不对`)
  }
  return failed
}
