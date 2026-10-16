// 完整模式的验收：一条连接接到设备服务的聚合面，里面有多个 harness。
// fullProbe 在真的外壳里对着隔离的多 harness 设备（scripts/device-fixture.mjs，两个 Pi 运行时）走一遍：
// 两个 harness 的会话都列出来、各发一句、新建会话时选 harness、一个 harness 掉线和恢复。
// 掉线是真的掉：页面打一行 LITCH_SIGNAL stop <标识>（恢复是 start），起自检的脚本看到后转给夹具。
// mockFullProbe 对着模拟核心看同样这些东西在界面上有没有（模拟核心里的本机就是一台完整模式的设备）。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。

interface HarnessSeen {
  id: string
  name: string
  badge: string
  state: string
}

export interface FullProbe {
  /** 设备详情里这台设备的 harness：标识、名字、徽标、状态 */
  harnesses: HarnessSeen[]
  /**
   * 侧栏里的会话：标题、它的 harness 的名字（徽标上的提示）和徽标。
   * 分辨是哪个 harness 靠名字：同一种引擎配了两份时，两份的徽标可以是一样的
   */
  rows: { title: string; harness: string; badge: string }[]
  /** 两个 harness 各打开一个会话发一句，回话是它自己那个 harness 回的 */
  firstEchoed: boolean
  secondEchoed: boolean
  /** 新建会话：出了选 harness 的选择器，默认是第一个可用的 */
  pickerShown: boolean
  defaultHarness: string
  /** 选了第二个：选择器和标题栏上的徽标跟着变，会话建在了它上面，回话是它回的 */
  pickedHarness: string
  titleHarness: string
  createdOn: string
  createdEchoed: boolean
  /** 再点新建，默认已经是上次用的那个 */
  remembered: string
  /**
   * 第二个 harness 掉线（正开着它上面的会话）：这一行看得出用不了，输入区说了发不了；
   * 设备行上只多一个记号、下面没有一直占着地方的说明，是哪个、为什么在信息卡里
   */
  downRow: boolean
  downChip: boolean
  downFlag: boolean
  downNoteShown: boolean
  downCard: string
  downHint: string
  /** 这时别的 harness 的会话没有跟着变样 */
  othersUntouched: boolean
  /** 它回来：这一行恢复原样、说明和提示都收掉，一直开着的这个会话不用重新打开就能接着发 */
  recovered: boolean
  resumedOpen: boolean
  /** 再掉一次：另一个 harness 的会话照常能发 */
  otherWorks: boolean
  /** 这时设备详情里它是“不可用”，带着原因；设备列表那一行上它的徽标也画成用不了的样子 */
  pageShowsDown: boolean
  downReason: string
  rowShowsDown: boolean
  /** 再回来：设备详情里恢复可用；回到早先打开过的那个会话，内容读得出来，能接着发 */
  pageShowsUp: boolean
  reopenedWorks: boolean
}

export async function fullProbe(): Promise<FullProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 60_000,
  ) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    throw new Error(`等不到：${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const write = (target: HTMLTextAreaElement, text: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(target, text)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: Element, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('textarea.cmp-text')
  const say = async (words: string) => {
    const input = await until('输入框', area)
    write(input, words)
    await frame()
    press(input, 'Enter')
    await frame()
  }
  const lastTurn = () => all('.turn').at(-1)?.textContent ?? ''
  const running = () => Boolean(one('.running-line'))
  /** 假模型把收到的话带回来，开头注明是哪个 harness 收到的 */
  const echoed = (harness: string, words: string) =>
    lastTurn().includes(`${harness} 收到：${words}`) && !running()
  /** 说一句，等它所在的 harness 把话带回来。等不到的时候把眼前看到的带上，好知道卡在哪 */
  const converse = async (harness: string, words: string, what: string) => {
    await say(words)
    try {
      await until(what, () => echoed(harness, words))
    } catch (error) {
      const seen = `最后一个回合：${lastTurn().slice(-200)}｜输入区：${text(one('.dock'))}`
      throw new Error(`${error instanceof Error ? error.message : String(error)}（${seen}）`)
    }
    return true
  }
  const rowOf = (title: string) => all('.ss-row').find((row) => text(one('.title', row)) === title)
  /** 一个徽标说的是哪个 harness：它的提示里写着名字 */
  const harnessOn = (root: Element | null | undefined) =>
    (root ? one('.chip', root) : null)?.title ?? ''
  /** 打开侧栏里的一个会话，等它的内容出来 */
  const open = async (title: string) => {
    ;(await until(`侧栏里的“${title}”`, () => rowOf(title))).click()
    await until(`“${title}”的内容`, () => text(one('.crumb b')) === title && one('.turn'))
  }
  const devicesLink = () => one<HTMLButtonElement>('.sb-link.devices')
  /**
   * 从设备列表点进本机的详情。列表的一行上只有徽标；名字、版本、状态和原因在详情里
   * （这台夹具设备没有设置接口，harness 一个一项地列在第一节里）。返回列表上本机那一行，没经过列表就是 null
   */
  const openDetail = async () => {
    devicesLink()?.click()
    const row = await until('设备列表上的本机', () =>
      one('[data-detail]') ? null : one<HTMLButtonElement>('.devp-item .devp-row'),
    )
    row.click()
    await until('本机的详情', () => one('[data-detail]'))
  }
  /** 设备详情里的 harness：每一项都带着标识和状态 */
  const listed = (): HarnessSeen[] =>
    all('[data-detail] .harness-entry').map((entry) => ({
      id: entry.dataset.harness ?? '',
      // 名字是这一项里直接写着的那段字，不算徽标、版本和状态小标
      name: [...entry.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join('')
        .trim(),
      badge: text(one('.chip', entry)),
      state: entry.dataset.state ?? '',
    }))
  const picker = () => one<HTMLButtonElement>('.pick[data-kind="harness"] .pick-btn')
  /** 侧栏里的本机，和它那一行上“有 harness 用不了”的记号 */
  const local = () => one('.dev-group') as HTMLElement
  const flag = () => one('.dev-flag', local())
  /** 鼠标停到本机那一行上，等信息卡出来。看完点一下让它收起 */
  const peek = async () => {
    const line = one('.row-line', local()) as HTMLElement
    line.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    const card = await until('设备的信息卡', () => one('.info-card'), 10_000)
    return {
      card,
      close: () => line.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })),
    }
  }

  // ---- 一、连上了：两个 harness 的会话都在侧栏里，各带各的徽标 ----
  await until('两个 harness 的会话都列出来', () => all('.ss-row').length >= 5)
  await until('侧栏底部的“设备”', devicesLink)
  await openDetail()
  const harnesses = await until('设备详情里的两个 harness', () => {
    const seen = listed()
    return seen.length >= 2 && seen.every((entry) => entry.state === 'ready') ? seen : null
  })
  const [first, second] = harnesses as [HarnessSeen, HarnessSeen]
  const rows = all('.ss-row').map((row) => ({
    title: text(one('.title', row)),
    harness: harnessOn(row),
    badge: text(one('.chip', row)),
  }))
  /** 这个 harness 的头一个会话 */
  const titleOn = (harness: HarnessSeen) =>
    rows.find((row) => row.harness === harness.name)?.title ?? ''

  // ---- 二、各打开一个会话，发一句 ----
  const onFirst = titleOn(first)
  await open(onFirst)
  const firstEchoed = await converse(first.id, '完整模式的第一句', '第一个 harness 的回话')
  const onSecond = titleOn(second)
  await open(onSecond)
  const secondEchoed = await converse(second.id, '第二个 harness 的一句', '第二个 harness 的回话')

  // ---- 三、新建会话：选第二个 harness，建在它上面 ----
  const add = () => one<HTMLButtonElement>('.dev-row ~ .row-add')
  ;(await until('设备行上的新建按钮', add)).click()
  await until('新建会话的页面', () => one('.new-hero'))
  const pickerShown = Boolean(await until('选 harness 的选择器', picker))
  const defaultHarness = text(picker())
  picker()?.click()
  ;(
    await until('第二个 harness 的选项', () =>
      one<HTMLButtonElement>(`.pick[data-kind="harness"] .pick-opt[data-option="${second.id}"]`),
    )
  ).click()
  await until('选择器换过去', () => text(picker()) === second.name)
  const pickedHarness = text(picker())
  const titleHarness = harnessOn(one('.crumb'))
  const opening = '建在第二个上的新会话'
  await say(opening)
  await until('落到新会话里', () => !one('.new-hero') && one('.ss-row.sel'))
  await until('新会话的回话', () => echoed(second.id, opening))
  const createdEchoed = true
  const createdOn = harnessOn(one('.ss-row.sel'))
  // 再点一次新建：默认已经是上次用的那个。看完回到刚建的会话
  add()?.click()
  await until('新建会话的页面', () => one('.new-hero') && picker())
  const remembered = text(picker())
  await open(opening)

  // ---- 四、第二个 harness 掉线：正开着的这个会话看得出用不了；它回来之后不用重新打开就能接着发 ----
  const isDown = (title: string) => Boolean(rowOf(title)?.classList.contains('down'))
  console.log(`LITCH_SIGNAL stop ${second.id}`)
  await until('这一行显示成用不了', () => isDown(opening), 30_000)
  const downRow = true
  const hint = () => text(one('.dock .cmp-hint.err'))
  await until('输入区说了发不了', () => hint().includes(second.name), 10_000)
  const downHint = hint()
  const downChip = Boolean(one('.chip.off', rowOf(opening)))
  const downFlag = Boolean(await until('设备行上的记号', flag, 10_000))
  const downNoteShown = Boolean(one('.dev-note', local()))
  const seen = await peek()
  const downCard = text(one(`.harness-entry[data-harness="${second.id}"]`, seen.card))
  seen.close()
  const othersUntouched = !isDown(onFirst) && !one('.chip.off', rowOf(onFirst))
  // 夹具要先看到那个运行时退出了，才肯把它重新起来
  await sleep(500)
  console.log(`LITCH_SIGNAL start ${second.id}`)
  await until('这一行恢复原样', () => !isDown(opening) && !hint() && !flag())
  const recovered = true
  const resumedOpen = await converse(second.id, '回来之后接着说', '回来之后的回话')

  // ---- 五、再掉一次：另一个 harness 照常能发；设备页上看得到它不可用和原因 ----
  console.log(`LITCH_SIGNAL stop ${second.id}`)
  await until('这一行又显示成用不了', () => isDown(opening), 30_000)
  await open(onFirst)
  const otherWorks = await converse(first.id, '另一个照常能发', '另一个 harness 的回话')
  devicesLink()?.click()
  const chip = () => one(`.devp-item .devp-chips .chip[data-harness="${second.id}"]`)
  await until('设备列表上它的徽标', chip)
  const rowShowsDown = Boolean(
    await until('列表上它的徽标画成用不了', () => chip()?.classList.contains('off'), 10_000),
  )
  await openDetail()
  const entry = () => one(`[data-detail] .harness-entry[data-harness="${second.id}"]`)
  await until('设备详情里它是不可用', () => entry()?.dataset.state === 'unavailable', 10_000)
  const downReason = text(one('.harness-why', entry() as HTMLElement))
  const pageShowsDown = Boolean(one('.pill', entry() as HTMLElement)) && downReason.length > 0
  await sleep(500)
  console.log(`LITCH_SIGNAL start ${second.id}`)
  await until('设备详情里它恢复可用', () => entry()?.dataset.state === 'ready')
  const pageShowsUp = !one('.harness-why', entry() as HTMLElement)

  // ---- 六、回到早先打开过的那个会话：内容读得出来，能接着发 ----
  await open(onSecond)
  const reopenedWorks = await converse(second.id, '恢复之后在早先的会话里说', '早先的会话里的回话')

  return {
    harnesses,
    rows,
    firstEchoed,
    secondEchoed,
    pickerShown,
    defaultHarness,
    pickedHarness,
    titleHarness,
    createdOn,
    createdEchoed,
    remembered,
    downRow,
    downChip,
    downFlag,
    downNoteShown,
    downCard,
    downHint,
    othersUntouched,
    recovered,
    resumedOpen,
    otherWorks,
    pageShowsDown,
    downReason,
    rowShowsDown,
    pageShowsUp,
    reopenedWorks,
  }
}

export function judgeFull(probe: FullProbe): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  const [first, second] = probe.harnesses
  must(
    probe.harnesses.length === 2 && Boolean(first?.name) && first?.name !== second?.name,
    `设备详情里没有列出两个名字分得开的 harness：${JSON.stringify(probe.harnesses)}`,
  )
  for (const harness of probe.harnesses) {
    must(
      probe.rows.some((row) => row.harness === harness.name && row.badge === harness.badge),
      `侧栏里没有 ${harness.id} 的会话，或者它的徽标不对：${JSON.stringify(probe.rows)}`,
    )
  }
  must(probe.rows.length >= 5, `侧栏里的会话不全（${probe.rows.length} 行）`)
  must(probe.firstEchoed, '在第一个 harness 的会话里发消息，没有收到它的回话')
  must(probe.secondEchoed, '在第二个 harness 的会话里发消息，没有收到它的回话')
  must(probe.pickerShown, '新建会话时没有出选 harness 的选择器')
  must(
    probe.defaultHarness === first?.name,
    `新建会话默认的不是第一个可用的 harness：${probe.defaultHarness}`,
  )
  must(probe.pickedHarness === second?.name, `选择器没有换到第二个 harness：${probe.pickedHarness}`)
  must(probe.titleHarness === second?.name, `标题栏上的徽标没有跟着选的走：${probe.titleHarness}`)
  must(
    probe.createdOn === second?.name && probe.createdEchoed,
    `新会话没有建在选的那个 harness 上：${probe.createdOn}`,
  )
  must(probe.remembered === second?.name, `再新建时默认的不是上次用的那个：${probe.remembered}`)
  must(probe.downRow && probe.downChip, 'harness 掉线之后，它的会话那一行看不出用不了')
  must(probe.downFlag, 'harness 掉线之后，侧栏的设备行上没有出记号')
  must(!probe.downNoteShown, 'harness 掉线之后，设备行下面又出了一直占着地方的说明')
  must(
    probe.downCard.includes(second?.name ?? '\0') && probe.downCard.includes('不可用'),
    `harness 掉线之后，设备的信息卡里没有说是哪个、怎么了：${probe.downCard}`,
  )
  must(
    probe.downHint.includes(second?.name ?? '\0'),
    `harness 掉线之后输入区没有说发不了：${probe.downHint}`,
  )
  must(probe.othersUntouched, '一个 harness 掉线，别的 harness 的会话也变了样')
  must(probe.recovered, 'harness 回来之后界面没有恢复')
  must(probe.resumedOpen, 'harness 回来之后，一直开着的会话发不了消息')
  must(probe.otherWorks, '一个 harness 掉线的时候，另一个 harness 的会话发不了消息')
  must(probe.pageShowsDown, `设备详情里没有显示它不可用和原因：${probe.downReason}`)
  must(probe.rowShowsDown, '设备列表那一行上，它的徽标没有画成用不了的样子')
  must(probe.pageShowsUp, '设备详情里它没有恢复成可用')
  must(probe.reopenedWorks, 'harness 回来之后，早先打开过的会话发不了消息')
  return failed
}

export interface MockFullProbe {
  /** 设备列表：本机那一行上有几个 harness 的徽标，哪几个画成用不了的样子 */
  harnessCount: number
  offChips: string[]
  /**
   * 侧栏：设备行上只有一个记号，下面没有一直占着地方的说明；鼠标停上去的信息卡里，
   * 不可用的那一个带着状态和原因，还说了它的会话是上次留下的
   */
  flagged: boolean
  noteShown: boolean
  downShown: string
  leftNote: string
  /**
   * 不可用的 harness 的会话那一行看得出用不了。行尾的菜单里只剩“置顶”：那是设备上的记录，不经过 harness；
   * 要够得着它才做得了的（改名、归档、删除、换工作区）都不出
   */
  downRows: number
  downRowMenu: string
  /** 新建会话的选择器：默认第一个可用的；不可用的列着但选不了 */
  defaultHarness: string
  options: number
  disabled: string[]
  /** 换一个 harness：模型的选择器跟着换成它自己的那一份，标题栏的徽标也换 */
  modelBefore: string
  modelAfter: string
  titleBadge: string
  /** 建出来的会话在选的那个 harness 上 */
  createdBadge: string
  /** 消息里说“掉线”：它的 harness 掉线，这一行、输入区都看得出；过一会儿自己回来，能接着发 */
  dropSeen: boolean
  dropHint: string
  dropRecovered: boolean
  sentAfter: boolean
}

export async function mockFullProbe(): Promise<MockFullProbe> {
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
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const say = async (words: string) => {
    const input = await until('输入框', () => one<HTMLTextAreaElement>('textarea.cmp-text'))
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input, words)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await frame()
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await frame()
  }
  const picker = () => one<HTMLButtonElement>('.pick[data-kind="harness"] .pick-btn')
  /** 底栏上紧跟在 harness 后面的那个选择器：模型 */
  const model = () => all('.cmp-bar .pick-btn')[1]

  // ---- 一、设备页和侧栏：本机是完整模式，有一个 harness 不可用 ----
  const local = await until('侧栏里的本机', () => one('.dev-group'))
  ;(await until('侧栏底部的“设备”', () => one<HTMLButtonElement>('.sb-link.devices'))).click()
  const row = await until('设备列表上的本机', () => one('.devp-item'))
  const chips = all('.devp-chips .chip[data-harness]', row)
  const harnessCount = chips.length
  const offChips = chips
    .filter((chip) => chip.classList.contains('off'))
    .map((chip) => chip.dataset.harness ?? '')
  const flagged = Boolean(one('.dev-flag', local))
  const noteShown = Boolean(one('.dev-note', local))
  // 鼠标停到设备那一行上：是哪个、为什么，在信息卡里
  const line = one('.row-line', local) as HTMLElement
  line.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  const card = await until('设备的信息卡', () => one('.info-card'), 10_000)
  const downShown = all('.harness-entry', card)
    .filter((entry) => entry.dataset.state !== 'ready')
    .map(
      (entry) =>
        `${entry.dataset.harness}：${text(one('.pill', entry))}：${text(one('.harness-why', entry))}`,
    )
    .join('；')
  const leftNote = text(one('[data-stranded]', card))
  line.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  await until('信息卡收起', () => !one('.info-card'))
  const downRow = all('.ss-row.down', local)
  const downRows = downRow.length
  let downRowMenu = ''
  const downLine = downRow[0]?.parentElement
  const more = downLine ? one<HTMLButtonElement>('.row-more > .ibtn', downLine) : null
  if (downLine && more) {
    more.click()
    const pop = await until('这一行的菜单', () => one('.row-more .pick-pop', downLine))
    downRowMenu = all('.pick-opt', pop).map(text).join('|')
    ;(document.activeElement ?? pop).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    await until('菜单收起', () => !pop.isConnected)
  }
  // ---- 二、新建会话：选 harness ----
  ;(
    await until('设备行上的新建按钮', () => one<HTMLButtonElement>('.dev-row ~ .row-add', local))
  ).click()
  await until('新建会话的页面', () => one('.new-hero') && picker() && model())
  const defaultHarness = text(picker())
  const modelBefore = text(model())
  picker()?.click()
  const choices = await until('harness 的选项', () => {
    const found = all('.pick[data-kind="harness"] .pick-opt')
    return found.length > 0 ? found : null
  })
  const options = choices.length
  const disabled = choices
    .filter((choice) => choice.getAttribute('aria-disabled') === 'true')
    .map((choice) => choice.dataset.option ?? '')
  // 选不了的点了也没用：选择器还开着，值没变
  choices.find((choice) => choice.getAttribute('aria-disabled') === 'true')?.click()
  await frame()
  choices.find((choice) => choice.dataset.option === 'pi')?.click()
  await until('选择器换成 Pi', () => text(picker()) === 'Pi')
  await until('模型的选择器换成 Pi 的那一份', () => text(model()) && text(model()) !== modelBefore)
  const modelAfter = text(model())
  const titleBadge = text(one('.crumb .chip'))

  // ---- 三、建出来，并让它的 harness 掉线再回来 ----
  await say('掉线试试看')
  const mine = await until('落到新会话里', () => !one('.new-hero') && one('.ss-row.sel'))
  const createdBadge = text(one('.chip', mine))
  const selected = () => one('.ss-row.sel')
  await until('这一行显示成用不了', () => selected()?.classList.contains('down'))
  const dropSeen = Boolean(one('.chip.off', selected() as HTMLElement))
  const dropHint = text(await until('输入区说了发不了', () => one('.dock .cmp-hint.err')))
  await until('它自己回来', () => !selected()?.classList.contains('down'))
  const dropRecovered = !one('.dock .cmp-hint.err')
  const before = all('.turn').length
  await say('回来之后再说一句')
  await until('回来之后的回合结束', () => all('.turn').length > before && !one('.running-line'))
  const sentAfter = true

  return {
    harnessCount,
    offChips,
    flagged,
    noteShown,
    downShown,
    leftNote,
    downRows,
    downRowMenu,
    defaultHarness,
    options,
    disabled,
    modelBefore,
    modelAfter,
    titleBadge,
    createdBadge,
    dropSeen,
    dropHint,
    dropRecovered,
    sentAfter,
  }
}

export function judgeMockFull(probe: MockFullProbe): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(probe.harnessCount === 4, `设备列表上本机的 harness 不是四个：${probe.harnessCount}`)
  must(
    probe.offChips.join() === 'codex',
    `设备列表上画成用不了的徽标不对：${probe.offChips.join()}`,
  )
  must(probe.flagged, '有 harness 用不了、侧栏里还留着它的会话，设备行上却没有记号')
  must(!probe.noteShown, '设备行下面又出了一直占着地方的说明')
  must(
    probe.downShown.startsWith('codex：不可用：') &&
      probe.downShown.length > 'codex：不可用：'.length,
    `信息卡里没有显示不可用的 harness 和原因：${probe.downShown}`,
  )
  must(probe.leftNote.length > 0, '信息卡里没有说它的会话是上次留下的')
  must(probe.downRows >= 1, '不可用的 harness 的会话那一行看不出用不了')
  must(
    probe.downRowMenu === '置顶',
    `不可用的 harness 的会话那一行，菜单里该只剩“置顶”：${probe.downRowMenu}`,
  )
  must(
    probe.defaultHarness === 'Claude Code',
    `新建会话默认的不是第一个可用的：${probe.defaultHarness}`,
  )
  must(
    probe.options === 4 && probe.disabled.join() === 'codex',
    `选择器里不可用的那一项不对：${probe.options} 项，选不了的是 ${probe.disabled.join()}`,
  )
  must(
    probe.modelAfter !== probe.modelBefore && probe.modelAfter.includes('Gate'),
    `换了 harness，模型的选择器没有跟着换：${probe.modelBefore} → ${probe.modelAfter}`,
  )
  must(probe.titleBadge === 'PI', `标题栏上的徽标没有跟着选的走：${probe.titleBadge}`)
  must(probe.createdBadge === 'PI', `新会话没有建在选的那个 harness 上：${probe.createdBadge}`)
  must(probe.dropSeen, 'harness 掉线之后这一行看不出用不了')
  must(probe.dropHint.includes('Pi'), `harness 掉线之后输入区没有说发不了：${probe.dropHint}`)
  must(probe.dropRecovered, 'harness 回来之后输入区的提示还在')
  must(probe.sentAfter, 'harness 回来之后发不了消息')
  return failed
}
