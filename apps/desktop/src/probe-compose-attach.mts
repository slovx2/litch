// 随消息带的文字的验收：贴进来的长文字转成一片、点开看、放回正文、拿掉、发出去并回正文、排队时跟着走。
// 接在计划模式那一组后面，模拟核心和真实入口都跑；样子（attachLook）只对着模拟核心量。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
// 真实入口的假模型把用户的话原样带回来（“收到：……”），回话里有那段文字末尾的记号，就说明它到了模型手里。

export interface AttachProbe {
  /** 贴一段短的：没有拦（照常进输入框），没有出片 */
  short: { stopped: boolean; chips: number }
  /**
   * 贴一段长的（四十一行，末尾有记号）：拦下了，出了一片，输入框里原来的字没动；片上写着行数；
   * 从贴到片出来用了多少毫秒；只带着这一片、不打字也发得了
   */
  long: {
    stopped: boolean
    chips: number
    kept: boolean
    label: string
    ms: number
    ready: boolean
  }
  /** 点开那一片：浮层里是那段文字，写着行数和字数；焦点进了浮层；按 Esc 收起，焦点回到片上 */
  peek: { shown: boolean; size: string; focusIn: boolean; closed: boolean; focusBack: boolean }
  /** 旁边有请求卡片的时候在浮层里按 Esc：只收起浮层，卡片还在。只在模拟核心上量 */
  besideCard: { closed: boolean; cardKept: boolean } | null
  /** 放回正文：输入框里是打的字、空一行、那段文字；片没了；焦点在输入框 */
  inlined: { value: boolean; chips: number; focused: boolean }
  /** 贴两段是两片，拿掉一片剩一片 */
  removed: { two: number; one: number }
  /** 发出去：对话里那条消息是打的字加那段文字，不另画附件；片清了；真实入口上回话里带着记号 */
  sent: { body: boolean; attachments: number; cleared: boolean; heard: boolean | null }
  /** 回合进行中再发一条带文字的：托盘那一行上有它的片；拿回来改，片回到输入区。没赶上回合还在跑就是 null */
  queued: { row: string; back: number } | null
  /** 太长的：拦下了，没出片，说了原因 */
  tooLong: { stopped: boolean; chips: number; said: string }
  /** 新建对话页上也一样：贴长的出片；发出去之后新会话的第一条是打的字加那段文字。只在模拟核心上量 */
  fresh: { chip: boolean; body: boolean } | null
}

export async function attachProbe(real: boolean): Promise<AttachProbe> {
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
    throw new Error(`带着的文字：等不到${what}`)
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
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: EventTarget, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  /** 往输入框里贴一段文字。返回页面有没有把它拦下来（拦下来的不会进输入框） */
  const paste = (target: HTMLTextAreaElement, words: string) => {
    const data = new DataTransfer()
    data.setData('text/plain', words)
    return !target.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }
  const chips = () => all('.dock .cmp-chip[data-kind="text"]')
  const peek = () => one('.dock .peek')
  const idle = () => until('这一轮结束', () => !running() && !one('.req') && area(), 90_000)
  const open = async (title: string) => {
    const row = await until(`侧栏里的“${title}”`, () =>
      all('.ss-row').find((entry) => text(entry).includes(title)),
    )
    row.click()
    await until(`“${title}”的内容`, () => text(one('.crumb')).includes(title) && one('.turn'))
    await frame()
    const input = await until('输入框', area)
    for (const cross of all('.dock .cmp-chip-x')) cross.click()
    if (input.value) write(input, '')
    input.focus()
    await frame()
    return input
  }

  const MARK = 'LITCH-PASTE-5512'
  const block = (lines: number, mark: string) =>
    [...Array.from({ length: lines }, (_, at) => `第 ${at + 1} 行：构建日志里的一行`), mark].join(
      '\n',
    )
  const long = block(40, MARK)
  const words = '看看这段日志哪里错了'

  // ---- 一、贴短的、贴长的 ----
  const main = real ? '给首页加一个状态条' : '核对构建机上的 codex 配置'
  let input = await open(main)
  await idle()
  // 只带着一片、不打字：发送按钮是亮的
  paste(input, long)
  await until('文字的那一片', () => chips().length === 1, 5000)
  const ready = one<HTMLButtonElement>('.dock .send')?.disabled === false
  one<HTMLButtonElement>('.dock .cmp-chip-x')?.click()
  await until('片拿掉', () => chips().length === 0, 5000)

  write(input, words)
  await frame()
  const shortStopped = paste(input, '短短一句，\n两行')
  await sleep(100)
  const short = { stopped: shortStopped, chips: chips().length }
  const pastedAt = performance.now()
  const stopped = paste(input, long)
  await until('文字的那一片', () => chips().length === 1, 5000)
  const ms = Math.round((performance.now() - pastedAt) * 10) / 10
  const label = text(one('.cmp-chip-open', chips()[0]))
  const longSeen = { stopped, chips: chips().length, kept: input.value === words, label, ms, ready }

  // ---- 二、点开看，Esc 收起 ----
  const opener = () => one<HTMLButtonElement>('.dock .cmp-chip-open')
  opener()?.click()
  const shownPeek = await until('点开的浮层', peek, 5000).catch(() => null)
  await frame()
  const seen = {
    shown: text(one('.peek-body', shownPeek ?? document)).endsWith(MARK),
    size: text(one('.peek-size', shownPeek ?? document)),
    focusIn: Boolean(shownPeek?.contains(document.activeElement)),
  }
  press(document.activeElement ?? document.body, 'Escape')
  await until('浮层收起', () => !peek(), 5000).catch(() => null)
  const peekSeen = { ...seen, closed: !peek(), focusBack: document.activeElement === opener() }

  // ---- 三、放回正文 ----
  opener()?.click()
  await until('点开的浮层', peek, 5000)
  one<HTMLButtonElement>('.dock .peek [data-act="inline"]')?.click()
  await until('片没了', () => chips().length === 0, 5000).catch(() => null)
  await frame()
  input = await until('输入框', area)
  const inlined = {
    value: input.value === `${words}\n\n${long}`,
    chips: chips().length,
    focused: document.activeElement === input,
  }

  // ---- 四、贴两段，拿掉一段 ----
  write(input, words)
  paste(input, long)
  await until('第一片', () => chips().length === 1, 5000)
  paste(input, block(50, '另一段'))
  await until('第二片', () => chips().length === 2, 5000).catch(() => null)
  const two = chips().length
  all('.dock .cmp-chip-x').at(-1)?.click()
  await until('剩一片', () => chips().length === 1, 5000).catch(() => null)
  const removed = { two, one: chips().length }

  // ---- 五、太长的 ----
  const tooStopped = paste(input, 'x'.repeat(1_000_001))
  await until('说了原因', () => one('.dock .cmp-hint.err'), 5000).catch(() => null)
  const tooLong = {
    stopped: tooStopped,
    chips: chips().length,
    said: text(one('.dock .cmp-hint.err')),
  }

  // ---- 六、发出去；回合还在跑的时候再发一条带文字的 ----
  const turnsBefore = all('.turn').length
  input.focus()
  press(input, 'Enter')
  await until('发出去的那一条', () => all('.turn').length > turnsBefore)
  const turn = () => all('.turn')[turnsBefore]
  await frame()
  const cleared = chips().length === 0 && area()?.value === ''
  let queued: AttachProbe['queued'] = null
  input = await until('输入框', area)
  if (running()) {
    write(input, '排着队的那一条')
    paste(input, block(35, '排队的那一段'))
    await until('排队那一条的片', () => chips().length === 1, 5000)
    press(input, 'Enter')
    const row = await until('托盘里的那一行', () => one('.tray-row'), 5000).catch(() => null)
    if (row) {
      const said = text(one('.mention', row))
      // 拿回来改：片回到输入区。然后清掉，不真的发第二条
      all('.mini', row)
        .find((button) => !button.classList.contains('steer'))
        ?.click()
      await until('片回到输入区', () => chips().length === 1, 5000).catch(() => null)
      queued = { row: said, back: chips().length }
      for (const cross of all('.dock .cmp-chip-x')) cross.click()
      const field = area()
      if (field) write(field, '')
    }
  }
  await idle()
  await sleep(200)
  const bubble = one('.umsg', turn())
  const marks = text(turn()).split(MARK).length - 1
  const said = text(one('.umsg-text', bubble ?? document))
  const sent = {
    // 真实入口上那条消息是对面回显的，前后的空白不一定一样：看头尾和中间
    body: real
      ? said.startsWith(words) && said.includes('第 40 行') && said.endsWith(MARK)
      : said === `${words}\n\n${long}`,
    attachments: all('.atts > *', bubble ?? document).length,
    cleared,
    heard: real ? marks >= 2 : null,
  }

  // ---- 七、旁边有请求卡片（只对着模拟核心）----
  let besideCard: AttachProbe['besideCard'] = null
  if (!real) {
    input = await until('输入框', area)
    write(input, '走一次审批')
    press(input, 'Enter')
    const card = await until('审批卡片', () => one('.req'), 30_000)
    input = await until('输入框', area)
    paste(input, long)
    await until('文字的那一片', () => chips().length === 1, 5000)
    opener()?.click()
    await until('点开的浮层', peek, 5000)
    await frame()
    press(document.activeElement ?? document.body, 'Escape')
    await until('浮层收起', () => !peek(), 5000).catch(() => null)
    await sleep(200)
    besideCard = { closed: !peek(), cardKept: one('.req') === card }
    for (const cross of all('.dock .cmp-chip-x')) cross.click()
    // 把卡片答掉，别留着
    const pending = one('.req')
    if (pending) {
      pending.focus()
      press(pending, 'Enter')
      await until('审批卡片消失', () => !one('.req'), 30_000)
    }
    await idle()
  }

  // ---- 八、新建对话页 ----
  let fresh: AttachProbe['fresh'] = null
  if (!real) {
    one<HTMLButtonElement>('.sb-link.new')?.click()
    await until('新建对话页', () => one('.new-page .new-hero') && area())
    const field = await until('新建对话页的输入框', area)
    for (const cross of all('.dock .cmp-chip-x')) cross.click()
    field.focus()
    const opening = '新对话一上来就带着一段日志'
    write(field, opening)
    paste(field, long)
    const chip = Boolean(
      await until('新建对话页上的片', () => chips().length === 1, 5000).catch(() => null),
    )
    press(field, 'Enter')
    const wanted = `${opening}\n\n${long}`
    const body = Boolean(
      await until(
        '新会话的第一条消息',
        () => !one('.new-page') && all('.umsg-text').some((entry) => text(entry) === wanted),
        60_000,
      ).catch(() => null),
    )
    fresh = { chip, body }
    await idle()
  }

  return {
    short,
    long: longSeen,
    peek: peekSeen,
    besideCard,
    inlined,
    removed,
    sent,
    queued,
    tooLong,
    fresh,
  }
}

export interface AttachLook {
  width: number
  height: number
  /**
   * 一种一行：“语言/皮肤/明暗｜横向溢出的像素｜岔子｜对比度：片上的字、浮层的标题、行数字数、那段文字、底下的说明、放回正文的按钮”
   */
  layouts: string[]
}

/** 带着的文字的样子：一片加点开的浮层，三种皮肤的深浅色、两种语言各量一遍。窗口多大由起自检的一方定 */
export async function attachLook(): Promise<AttachLook> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 10_000,
  ) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    throw new Error(`带着的文字的样子：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')

  // 等窗口的大小定下来（起自检的一方可能刚改过）
  const settle = performance.now() + 5000
  let last = ''
  while (performance.now() < settle) {
    await sleep(120)
    const size = `${window.innerWidth}x${window.innerHeight}`
    if (size === last) break
    last = size
  }
  const title = '首页文案'
  const row = await until(`侧栏里的“${title}”`, () =>
    all('.ss-row').find((entry) => text(entry).includes(title)),
  )
  row.click()
  await until(`“${title}”的内容`, () => text(one('.crumb')).includes(title) && one('.turn'))
  /** 带上一片，把它点开（换语言之后输入区可能是新的一份，重新来一遍） */
  const show = async () => {
    const field = await until('输入框', area)
    if (!one('.dock .cmp-chip[data-kind="text"]')) {
      const data = new DataTransfer()
      // 一行很长、不带空格的，加上很多行：浮层里横竖都要装得下
      const lines = Array.from(
        { length: 120 },
        (_, at) => `第 ${at + 1} 行 ${'/very/long/path'.repeat(12)}`,
      )
      data.setData('text/plain', lines.join('\n'))
      field.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    }
    const opener = await until('文字的那一片', () => one<HTMLButtonElement>('.dock .cmp-chip-open'))
    if (!one('.dock .peek')) opener.click()
    await until('点开的浮层', () => one('.dock .peek'))
    await frame()
  }

  type Rgba = [number, number, number, number]
  const parse = (color: string): Rgba => {
    const parts = (color.match(/-?[\d.]+(?:e-?\d+)?/g) ?? []).map(Number)
    // color(srgb r g b / a) 里的分量是 0 到 1
    const scale = color.startsWith('color(') ? 255 : 1
    const [r = 0, g = 0, b = 0] = parts.slice(0, 3).map((part) => part * scale)
    return [r, g, b, parts[3] ?? 1]
  }
  const over = (top: Rgba, under: Rgba): Rgba => [
    top[0] * top[3] + under[0] * (1 - top[3]),
    top[1] * top[3] + under[1] * (1 - top[3]),
    top[2] * top[3] + under[2] * (1 - top[3]),
    1,
  ]
  /** 一个元素底下实际垫着的颜色：半透明的底色一层层叠到第一层不透明的上面 */
  const backdrop = (element: HTMLElement): Rgba => {
    const layers: Rgba[] = []
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor)
      if (color[3] > 0) layers.push(color)
      if (color[3] >= 1) break
    }
    let base: Rgba = parse(getComputedStyle(document.body).backgroundColor)
    for (const layer of layers.reverse()) base = over(layer, base)
    return base
  }
  const luminance = (color: Rgba) => {
    const [r = 0, g = 0, b = 0] = color.slice(0, 3).map((part) => {
      const channel = part / 255
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const readable = (selector: string) => {
    const element = one(selector)
    if (!element) return 0
    const under = backdrop(element)
    const ink = over(parse(getComputedStyle(element).color), under)
    const [high = 0, low = 0] = [luminance(ink), luminance(under)].sort((x, y) => y - x)
    return (high + 0.05) / (low + 0.05)
  }
  const overflow = () =>
    Math.max(
      0,
      ...[
        document.documentElement,
        one('.main'),
        one('.dock-in'),
        one('.dock .cmp-atts'),
        one('.dock .cmp-bar'),
        one('.dock .peek'),
        one('.dock .peek-head'),
        // 那段文字自己会折行，横向不该滚
        one('.dock .peek-body'),
        one('.dock .peek-foot'),
        ...all('.dock .cmp-chip'),
      ].map((box) => (box ? box.scrollWidth - box.clientWidth : 0)),
    )
  const faults = () => {
    const found: string[] = []
    const box = one('.dock .peek')?.getBoundingClientRect()
    const cmp = one('.dock .cmp')?.getBoundingClientRect()
    const main = one('.main')?.getBoundingClientRect()
    if (!box || !cmp || !main) return '浮层或者输入框不在'
    if (box.bottom > cmp.top + 0.5) found.push('浮层压着输入框')
    if (box.top < main.top - 0.5) found.push('浮层伸到了主区域上面')
    if (box.left < main.left - 0.5 || box.right > main.right + 0.5) found.push('浮层伸到左右外面')
    const body = one('.dock .peek-body')?.getBoundingClientRect()
    if (!body || body.height < 54) found.push('浮层里那段文字露出来的不到三行')
    for (const each of all('.dock .peek-foot .btn, .dock .peek-head .ibtn')) {
      const at = each.getBoundingClientRect()
      if (at.right > box.right + 0.5 || at.bottom > box.bottom + 0.5 || at.top < box.top - 0.5) {
        found.push('按钮伸到浮层外面')
      }
      const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2)
      if (!hit || !each.contains(hit)) found.push('按钮被盖住了')
    }
    const chip = one('.dock .cmp-chip[data-kind="text"]')?.getBoundingClientRect()
    if (!chip || chip.left < cmp.left - 0.5 || chip.right > cmp.right + 0.5) {
      found.push('片不在输入区里')
    }
    return [...new Set(found)].join('、')
  }

  // 换皮肤、明暗、语言走界面给验收留的口子（window.__litchLook），不直接改根元素上的属性
  const appearance = (
    window as unknown as {
      __litchLook: {
        get(): { skin: string; theme: string; lang: string }
        set(patch: { skin?: string; theme?: string; lang?: string }): void
      }
    }
  ).__litchLook
  const was = appearance.get()
  const layouts: string[] = []
  for (const language of ['中文', '英文']) {
    appearance.set({ lang: language === '中文' ? 'zh-CN' : 'en' })
    await sleep(200)
    await show()
    for (const skin of ['retro', 'human', 'standard']) {
      for (const theme of ['light', 'dark']) {
        appearance.set({ skin, theme })
        await sleep(200)
        const numbers = [
          readable('.dock .cmp-chip[data-kind="text"] .ell'),
          readable('.dock .peek-head b'),
          readable('.dock .peek-size'),
          readable('.dock .peek-body'),
          readable('.dock .peek-foot .grow'),
          readable('.dock .peek-foot [data-act="inline"]'),
        ]
        layouts.push(
          `${language}/${skin}/${theme}｜${Math.ceil(overflow())}｜${faults()}｜${numbers
            .map((value) => value.toFixed(1))
            .join(':')}`,
        )
      }
    }
  }
  appearance.set(was)
  await show()
  one<HTMLButtonElement>('.dock .peek [data-act="remove"]')?.click()
  await sleep(100)
  return { width: window.innerWidth, height: window.innerHeight, layouts }
}

/** look 只在模拟核心上有：wide 是平常大小的窗口里量的，narrow 是缩到允许的最小之后量的 */
export function judgeAttach(
  probe: AttachProbe,
  real: boolean,
  look: { wide: AttachLook; narrow: AttachLook } | null,
): string[] {
  const failed: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) failed.push(`带着的文字：${what}`)
  }
  check(!probe.short.stopped && probe.short.chips === 0, '贴一段短的也被拦下、转成了片')
  check(probe.long.stopped, '贴一段长的没有拦下来')
  check(probe.long.chips === 1, `贴一段长的该出一片，出了 ${probe.long.chips} 片`)
  check(probe.long.kept, '贴一段长的，输入框里原来的字变了')
  check(probe.long.label.includes('41'), `片上没有写行数：“${probe.long.label}”`)
  check(probe.long.ms < 200, `贴进来 ${probe.long.ms} 毫秒片才出来`)
  check(probe.long.ready, '只带着一段文字、不打字的时候发不了')
  check(probe.peek.shown, '点开那一片，浮层里不是那段文字')
  check(
    probe.peek.size.includes('41') && probe.peek.size.includes('647'),
    `浮层上的行数字数不对：“${probe.peek.size}”`,
  )
  check(probe.peek.focusIn, '点开之后焦点没有进浮层')
  check(probe.peek.closed, '按 Esc 浮层没有收起')
  check(probe.peek.focusBack, '浮层收起之后焦点没有回到那一片上')
  if (probe.besideCard) {
    check(probe.besideCard.closed, '旁边有请求卡片的时候按 Esc，浮层没有收起')
    check(probe.besideCard.cardKept, '在浮层里按 Esc，把旁边的请求卡片也答掉了')
  }
  check(probe.inlined.value, '放回正文之后输入框里不是“打的字、空一行、那段文字”')
  check(probe.inlined.chips === 0, '放回正文之后那一片还在')
  check(probe.inlined.focused, '放回正文之后焦点不在输入框里')
  check(
    probe.removed.two === 2 && probe.removed.one === 1,
    `贴两段该是两片、拿掉一片剩一片，实际是 ${probe.removed.two} 和 ${probe.removed.one}`,
  )
  check(probe.tooLong.stopped && probe.tooLong.chips === 1, '太长的那一段没有拦住，或者出了片')
  check(probe.tooLong.said.length > 0, '太长的那一段带不上，没有说原因')
  check(probe.sent.body, '发出去的那条消息不是“打的字加那段文字”')
  check(probe.sent.attachments === 0, '带着的文字发出去之后又另外画成了附件')
  check(probe.sent.cleared, '发出去之后输入区里的片或者字还在')
  if (real)
    check(probe.sent.heard === true, '真实入口：回话里没有那段文字末尾的记号，它没到模型手里')
  check(probe.queued !== null, '没赶上在回合进行中排一条带文字的消息')
  if (probe.queued) {
    check(probe.queued.row.includes('36'), `托盘那一行上没有带着的文字：“${probe.queued.row}”`)
    check(probe.queued.back === 1, '把排着的那条拿回来改，带着的文字没有回到输入区')
  }
  if (probe.fresh) {
    check(probe.fresh.chip, '新建对话页上贴长的没有出片')
    check(probe.fresh.body, '新建对话页上带着文字发第一条，新会话的第一条不是“打的字加那段文字”')
  }
  if (!real && !look) check(false, '没有量样子')
  for (const [name, each] of Object.entries(look ?? {})) {
    if (each.layouts.length !== 12) {
      check(false, `${name}：该量 12 种样子，量了 ${each.layouts.length} 种`)
    }
    for (const line of each.layouts) {
      const [which = '', spill = '', faults = '', numbers = ''] = line.split('｜')
      if (spill !== '0') failed.push(`带着的文字的样子（${name} ${which}）：横向溢出 ${spill} 像素`)
      if (faults) failed.push(`带着的文字的样子（${name} ${which}）：${faults}`)
      const [chip = 0, title = 0, size = 0, body = 0, note = 0, button = 0] = numbers
        .split(':')
        .map(Number)
      // 正文一样要读的字 4.5 起，淡下去的说明 3 起
      for (const [label, value, least] of [
        ['片上的字', chip, 4.5],
        ['浮层的标题', title, 4.5],
        ['行数字数', size, 3],
        ['那段文字', body, 4.5],
        ['底下的说明', note, 3],
        ['放回正文的按钮', button, 4.5],
      ] as const) {
        if (value < least) {
          failed.push(`带着的文字的样子（${name} ${which}）：${label}和底色分不开（${value}）`)
        }
      }
    }
  }
  return failed
}
