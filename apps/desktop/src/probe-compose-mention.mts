// `@` 提到文件的验收：打 @ 弹出找文件的单子、选中变成一片、发出去怎么带。
// 接在带文件那一组后面，模拟核心和真实入口都跑；单子的样子用 probe-compose-more.mts 的 slashLook('at') 量。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
// 模拟核心里每个工作区的根下面都是同一棵示例文件树（serve.go、docs/ 等），build-01 上不提供找文件；
// “原生 codex 上路径写进正文”不在这里量：模拟核心里没有哪台设备既会找文件、又有能发消息的 Codex，
// 它在核心的单元测试里（declared.test.mts）。
// 真实入口上那个会话的工作目录里有夹具造会话时写下的 status.txt。

export interface MentionProbe {
  /** 打下 @ 到单子出来用了多少毫秒；这时还没打字，单子上说的是什么 */
  openMs: number
  hint: string
  /** 接着打字到结果列出来用了多少毫秒（含停下打字之后等的那一小会儿）；列了哪些 */
  resultsMs: number
  listed: string[]
  /** 选中那一项的完整位置写在单子底下那一栏 */
  foot: string
  /** 单子摆得对不对（出的岔子，没有就是空的） */
  faults: string
  /** 上下键在单子里走；这时输入框里的字没动 */
  keys: { moved: boolean; textKept: boolean }
  /** Esc 只关单子，字还在；同一个词接着打不再弹 */
  esc: { closed: boolean; textKept: boolean; stayedClosed: boolean }
  /** 回车选中：出了一片，触发词从输入框里拿掉了，别的字还在，焦点还在输入框 */
  picked: { chip: string; title: string; text: string; focusKept: boolean }
  /** 话中间再提一个目录；同一个文件再选一遍还是一片 */
  more: { chips: string[]; afterSame: number } | null
  /** 夹在词中间的 @（邮箱地址）不弹单子；什么都对不上的时候单子上说了 */
  midWord: boolean
  none: string
  /**
   * 发出去：收 mention 的 harness 上对话里那条消息带着提到的文件（模拟核心里是 Claude Code）；
   * 真实入口的 Pi 把它化成了一行路径，回话里有这个路径就是到了模型手里
   */
  sent: { mentions: string[]; text: string; cleared: boolean; heard: boolean | null }
  /** 请求卡片挂着的时候：单子照样出来，上下键、回车、Esc 都归单子，卡片还在。只在模拟核心上量 */
  withCard: {
    popup: boolean
    moved: boolean
    chip: string
    escClosed: boolean
    cardKept: boolean
  } | null
  /** 对面不提供找文件的设备（模拟核心里的 build-01）：单子照样出来，上面说的是什么。只在模拟核心上量 */
  unsupported: string | null
  /** 新建对话页：选了工作区就找得了；没选工作区的时候单子上说先选一个。只在模拟核心上量 */
  fresh: { listed: number; noRoot: string } | null
}

export async function mentionProbe(real: boolean): Promise<MentionProbe> {
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
    throw new Error(`提到文件：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const write = (target: HTMLTextAreaElement, words: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      target,
      words,
    )
    target.setSelectionRange(words.length, words.length)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: EventTarget, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  const sheet = () => one('.dock .sug [data-group="files"]')
  const rows = () => all('.dock .sug-opt[data-kind="file"], .dock .sug-opt[data-kind="dir"]')
  const names = () => rows().map((row) => text(one('b', row)))
  const picked = () => one('.dock .sug-opt[aria-selected="true"]')
  const note = () => text(one('.dock .sug-note'))
  const chips = () => all('.dock .cmp-chip[data-kind="file"]')
  const labels = () => chips().map((chip) => text(one('.ell', chip)))
  const idle = () => until('这一轮结束', () => !running() && !one('.req') && area(), 90_000)
  const clear = () => {
    for (const cross of all('.dock .cmp-chip-x')) cross.click()
    const field = area()
    if (field?.value) write(field, '')
  }
  const open = async (title: string) => {
    const row = await until(`侧栏里的“${title}”`, () =>
      all('.ss-row').find((entry) => text(entry).includes(title)),
    )
    row.click()
    await until(`“${title}”的内容`, () => text(one('.crumb')).includes(title) && area())
    await frame()
    await idle()
    clear()
    const field = await until('输入框', area)
    field.focus()
    await frame()
    return field
  }
  /** 打一个带 @ 的词，等结果里有 wanted 开头的那一项 */
  const find = async (field: HTMLTextAreaElement, words: string, wanted: string) => {
    write(field, words)
    await until(
      `“${wanted}”那一项`,
      () => names().some((name) => name.startsWith(wanted)),
      15_000,
    ).catch(() => {
      throw new Error(
        `提到文件：打了“${words}”等不到“${wanted}”那一项（输入框里是“${area()?.value}”，单子${one('.dock .sug') ? '开着' : '没开'}，列着 ${names().join(' ') || '空的'}，说的是“${note()}”，焦点${document.activeElement === area() ? '在' : '不在'}输入框）`,
      )
    })
    // 走到那一项上
    for (let step = 0; step < 60; step++) {
      if (text(one('b', picked() ?? document)).startsWith(wanted)) break
      press(field, 'ArrowDown')
      await frame()
    }
  }
  const send = async (words: string) => {
    const before = all('.turn').length
    const field = await until('输入框', area)
    field.focus()
    write(field, words)
    await frame()
    press(field, 'Enter')
    await until('发出去的那一条', () => all('.turn').length > before)
    await frame()
    const cleared = all('.dock .cmp-chip').length === 0 && area()?.value === ''
    await idle()
    await sleep(200)
    const turn = all('.turn')[before]
    const bubble = one('.umsg', turn)
    return {
      whole: text(turn),
      mentions: all('.atts .mention', bubble ?? document).map(text),
      text: text(one('.umsg-text', bubble ?? document)),
      cleared,
    }
  }
  const faults = (): string => {
    const found: string[] = []
    const box = one('.dock .sug')?.getBoundingClientRect()
    const cmp = one('.dock .cmp')?.getBoundingClientRect()
    const main = one('.main')?.getBoundingClientRect()
    if (!box || !cmp || !main) return '单子或者输入框不在'
    if (box.bottom > cmp.top + 0.5) found.push('单子压着输入框')
    if (box.top < main.top - 0.5) found.push('单子伸到了主区域上面')
    if (box.left < main.left - 0.5 || box.right > main.right + 0.5) found.push('单子伸到左右外面')
    for (const row of rows()) {
      if (row.scrollWidth > row.clientWidth + 1) found.push('有一行横向溢出')
    }
    const at = picked()?.getBoundingClientRect()
    if (!at) found.push('没有选中的那一行')
    return [...new Set(found)].join('、')
  }

  // ---- 一、打 @：单子出来；接着打字：结果列出来 ----
  const main = real ? '给首页加一个状态条' : '首页文案'
  const wanted = real ? 'status.txt' : 'serve.go'
  const typed = real ? '@stat' : '@serve'
  let field = await open(main)
  const openedAt = performance.now()
  write(field, '看看 @')
  await until('找文件的单子', sheet, 5000)
  const openMs = Math.round((performance.now() - openedAt) * 10) / 10
  await frame()
  const hint = note()
  const askedAt = performance.now()
  write(field, `看看 ${typed}`)
  await until('找到的文件', () => names().some((name) => name.startsWith(wanted)), 15_000)
  const resultsMs = Math.round(performance.now() - askedAt)
  const listed = names()
  await find(field, `看看 ${typed}`, wanted)
  await frame()
  const foot = text(one('.dock .sug-foot'))
  const placed = faults()

  // ---- 二、按键 ----
  const firstPicked = picked()?.dataset.entry
  press(field, 'ArrowDown')
  await frame()
  const movedTo = picked()?.dataset.entry
  press(field, 'ArrowUp')
  await frame()
  const keys = {
    // 只有一项的时候上下键绕回它自己：算走得通
    moved: rows().length === 1 ? movedTo === firstPicked : movedTo !== firstPicked,
    textKept: field.value === `看看 ${typed}`,
  }
  press(field, 'Escape')
  await until('单子收起', () => !one('.dock .sug'), 5000).catch(() => null)
  const closed = !one('.dock .sug')
  const keptAfterEsc = field.value === `看看 ${typed}`
  write(field, `看看 ${typed}${real ? 'u' : '.'}`)
  await sleep(300)
  const esc = { closed, textKept: keptAfterEsc, stayedClosed: !one('.dock .sug') }

  // ---- 三、回车选中 ----
  // 先清掉、等一帧：Esc 关掉的那个词要删了重打才再弹
  write(field, '')
  await frame()
  await frame()
  await find(field, `看看 ${typed}`, wanted)
  press(field, 'Enter')
  await until('提到的文件的那一片', () => chips().length === 1, 5000).catch(() => null)
  await frame()
  field = await until('输入框', area)
  const pickedSeen = {
    chip: labels()[0] ?? '',
    title: chips()[0]?.getAttribute('title') ?? '',
    text: field.value,
    focusKept: document.activeElement === field,
  }

  // ---- 四、再提一个目录；同一个文件再选一遍；邮箱；对不上的 ----
  let more: MentionProbe['more'] = null
  if (!real) {
    await find(field, '看看 @doc', 'docs/')
    press(field, 'Tab')
    await until('目录的那一片', () => chips().length === 2, 5000).catch(() => null)
    const seen = labels()
    await find(field, '看看 @serve', wanted)
    press(field, 'Enter')
    await sleep(200)
    more = { chips: seen, afterSame: chips().length }
  }
  write(field, 'dev@example')
  await sleep(300)
  const midWord = !one('.dock .sug')
  write(field, '@zzzzqqqq-nothing')
  await until(
    '“没有对得上的”',
    () => sheet() && rows().length === 0 && /没有|No /.test(note()),
    15_000,
  ).catch(() => null)
  const none = note()
  write(field, '')

  // ---- 五、发出去 ----
  const said = await send('看看这几处')
  const path = real ? wanted : 'serve.go'
  const sent = {
    mentions: said.mentions,
    text: said.text,
    cleared: said.cleared,
    // 假模型把收到的话原样带回来：回话里也有这个路径
    heard: real ? said.whole.split(path).length - 1 >= 2 : null,
  }

  // ---- 六、请求卡片挂着的时候（只对着模拟核心）----
  let withCard: MentionProbe['withCard'] = null
  if (!real) {
    field = await until('输入框', area)
    write(field, '走一次审批')
    press(field, 'Enter')
    const card = await until('审批卡片', () => one('.req'), 30_000)
    field = await until('输入框', area)
    field.focus()
    write(field, '@serve')
    const popup = Boolean(
      await until(
        '找到的文件',
        () => names().some((name) => name.startsWith(wanted)),
        15_000,
      ).catch(() => null),
    )
    const before = picked()?.dataset.entry
    press(field, 'ArrowDown')
    await frame()
    const moved = rows().length === 1 || picked()?.dataset.entry !== before
    await find(field, '@serve', wanted)
    press(field, 'Enter')
    await until('提到的文件的那一片', () => chips().length === 1, 5000).catch(() => null)
    const chip = labels()[0] ?? ''
    write(field, '@serve')
    await until('找到的文件', () => rows().length > 0, 15_000).catch(() => null)
    press(field, 'Escape')
    await until('单子收起', () => !one('.dock .sug'), 5000).catch(() => null)
    await sleep(200)
    withCard = {
      popup,
      moved,
      chip,
      escClosed: !one('.dock .sug'),
      cardKept: one('.req') === card,
    }
    clear()
    const pending = one('.req')
    if (pending) {
      pending.focus()
      press(pending, 'Enter')
      await until('审批卡片消失', () => !one('.req'), 30_000)
    }
    await idle()
  }

  // ---- 七、对面不提供找文件 ----
  let unsupported: MentionProbe['unsupported'] = null
  if (!real) {
    field = await open('核对构建机上的 codex 配置')
    write(field, '@serve')
    await until('找文件的单子', sheet, 5000).catch(() => null)
    await until('说了找不了', () => /不提供/.test(note()), 15_000).catch(() => null)
    unsupported = rows().length === 0 ? note() : `列了 ${rows().length} 项`
    write(field, '')
  }

  // ---- 八、新建对话页 ----
  let fresh: MentionProbe['fresh'] = null
  if (!real) {
    one<HTMLButtonElement>('.sb-link.new')?.click()
    await until('新建对话页', () => one('.new-page .new-hero') && area())
    clear()
    /** 点开页上的一个选择器（device、workspace），选标题是这几个字的那一项 */
    const choose = async (kind: string, title: string) => {
      const button = () => one<HTMLButtonElement>(`.pick[data-kind="${kind}"] .pick-btn`)
      if (text(button()) === title) return
      ;(await until(`“${kind}”的选择器`, button)).click()
      const option = await until(`“${kind}”里的“${title}”`, () =>
        all(`.pick[data-kind="${kind}"] .pick-opt`).find(
          (entry) => text(one('b', entry)) === title,
        ),
      )
      option.click()
      await until(`“${kind}”换成“${title}”`, () => text(button()) === title)
      await frame()
    }
    await choose('device', '本机')
    await choose('workspace', '无工作区')
    field = await until('新建对话页的输入框', area)
    field.focus()
    write(field, '@serve')
    await until('找文件的单子', sheet, 5000).catch(() => null)
    await sleep(400)
    const noRoot = rows().length === 0 ? note() : `列了 ${rows().length} 项`
    write(field, '')
    // 选一个工作区：这回找得了
    await choose('workspace', 'docs-site')
    field = await until('新建对话页的输入框', area)
    field.focus()
    write(field, '@serve')
    await until('找到的文件', () => rows().length > 0, 15_000).catch(() => null)
    fresh = { listed: rows().length, noRoot }
    write(field, '')
  }

  return {
    openMs,
    hint,
    resultsMs,
    listed,
    foot,
    faults: placed,
    keys,
    esc,
    picked: pickedSeen,
    more,
    midWord,
    none,
    sent,
    withCard,
    unsupported,
    fresh,
  }
}

export function judgeMention(probe: MentionProbe, real: boolean): string[] {
  const failed: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) failed.push(`提到文件：${what}`)
  }
  const wanted = real ? 'status.txt' : 'serve.go'
  check(probe.openMs < 100, `打下 @ ${probe.openMs} 毫秒单子才出来`)
  check(probe.hint.length > 0, '刚打下 @ 的时候单子上什么都没说')
  check(probe.resultsMs < 3000, `文件 ${probe.resultsMs} 毫秒才列出来`)
  check(probe.listed.includes(wanted), `单子上没有 ${wanted}（有的是 ${probe.listed.join(' ')}）`)
  check(probe.foot.includes(wanted), `单子底下那一栏没有写完整的位置：“${probe.foot}”`)
  check(probe.faults === '', `单子摆得不对：${probe.faults}`)
  check(probe.keys.moved, '上下键没有在单子里走')
  check(probe.keys.textKept, '上下键动了输入框里的字')
  check(probe.esc.closed, 'Esc 没有把单子关掉')
  check(probe.esc.textKept, 'Esc 把输入框里的字也清了')
  check(probe.esc.stayedClosed, 'Esc 关掉之后同一个词接着打，单子又弹出来了')
  check(probe.picked.chip === wanted, `回车选中之后的片不对：“${probe.picked.chip}”`)
  check(probe.picked.title.includes(wanted), `片上鼠标移上去没有路径：“${probe.picked.title}”`)
  check(probe.picked.text === '看看 ', `选中之后输入框里该剩“看看 ”，实际是“${probe.picked.text}”`)
  check(probe.picked.focusKept, '选中之后焦点不在输入框里')
  if (probe.more) {
    check(
      probe.more.chips.join() === `${wanted},docs/`,
      `再提一个目录之后该是两片，实际是 ${probe.more.chips.join() || '没有'}`,
    )
    check(probe.more.afterSame === 2, '同一个文件选了两遍，带了两片')
  }
  check(probe.midWord, '夹在词中间的 @（邮箱地址）弹了单子')
  check(probe.none.length > 0, '什么都对不上的时候单子上没有说')
  check(probe.sent.cleared, '发出去之后输入区里的片或者字还在')
  if (real) {
    check(probe.sent.heard === true, '真实入口：回话里没有提到的那个文件的路径，它没到模型手里')
  } else {
    check(
      probe.sent.mentions.join() === `${wanted},docs/` && probe.sent.text === '看看这几处',
      `带着提到的文件发出去的消息不对：${JSON.stringify(probe.sent)}`,
    )
    check(
      probe.withCard !== null && probe.unsupported !== null && probe.fresh !== null,
      '有几步没有量到',
    )
  }
  const card = probe.withCard
  if (card) {
    check(card.popup, '请求卡片挂着的时候找文件的单子出不来')
    check(card.moved, '请求卡片挂着的时候，上下键没有在单子里走')
    check(card.chip === wanted, `请求卡片挂着的时候回车选中的片不对：“${card.chip}”`)
    check(card.escClosed, '请求卡片挂着的时候，Esc 没有关掉单子')
    check(card.cardKept, '请求卡片挂着的时候，单子的按键落到了卡片上')
  }
  if (probe.unsupported !== null) {
    check(
      probe.unsupported.includes('不提供'),
      `对面不提供找文件的设备上，单子上没有照实说：“${probe.unsupported}”`,
    )
  }
  if (probe.fresh) {
    check(probe.fresh.listed > 0, '新建对话页上选了工作区，打 @ 没有找到文件')
    check(
      probe.fresh.noRoot.includes('工作区'),
      `新建对话页上没选工作区，打 @ 该说先选一个：“${probe.fresh.noRoot}”`,
    )
  }
  return failed
}
