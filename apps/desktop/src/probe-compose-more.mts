// 输入区第二批功能的验收，头一件：打 `/` 弹出来的命令和技能。
// 排在 check:compose 的最后（请求卡片那一组之后），模拟核心和真实入口都跑：
// - slashProbe：单子出不出得来、按键归谁、过滤、选中之后变成什么、发出去带没带上、
//   和请求卡片并存时按键漏不漏；模拟核心上再看各种取不到的情形和新建对话页；
// - slashLook（只对着模拟核心）：三种皮肤的深浅色下单子和小片有没有溢出、字和底色分不分得开。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
// 模拟核心里各 harness 的技能见 packages/core/src/mock/sample-compose.mts；
// 真实入口的 Pi 上有一项造出来的技能（scripts/client-fixture.mjs 的 SKILL）。

export interface SlashProbe {
  /** 打下斜杠到单子出现在页面上隔了多久；到技能列出来隔了多久（毫秒） */
  openMs: number
  skillsMs: number
  /** 头一回取技能的时候单子上写着“正在取”。只在模拟核心上量（它的应答故意晚一点到） */
  loadingSeen: boolean | null
  /** 单子上列的命令、技能（各是它们的名字） */
  commands: string[]
  skills: string[]
  /** 单子底下那一栏写的是选中那一项的说明 */
  footShown: boolean
  /** 单子摆得对不对：出的岔子，没有就是空的 */
  faults: string
  /** 上下键在单子里走（到头绕回去），这些键没有落到输入框上（光标没动、没翻输入历史） */
  keys: { down: boolean; up: boolean; wrap: boolean; held: boolean; textKept: boolean }
  /** 接着打字是过滤：打了 rev／note 之后剩下的条目 */
  filtered: string[]
  /** 什么都对不上时单子上说的话 */
  noneSaid: string
  /** Esc 关掉单子：字还在；接着打不再弹；删掉重打又弹 */
  esc: { closed: boolean; textKept: boolean; stayedClosed: boolean; reopened: boolean }
  /** 回车选中技能：触发词没了，多出一片，焦点还在输入框 */
  picked: { chip: string; textCleared: boolean; focusKept: boolean }
  /** 同一项再选一遍不会多一片；Tab 也能选；鼠标点也能选，按下的那一下没有把焦点带走 */
  again: { same: boolean; byTab: string; byClick: string; mouseHeld: boolean }
  /** 片上的叉拿得掉 */
  removed: boolean
  /** 带着技能发出去：气泡里有技能的名字和正文，输入区里的片清掉了 */
  sent: { mentions: string[]; text: string; cleared: boolean }
  /** 技能有没有真的到了模型手里（回话里带着技能正文里的记号）。只在真实入口上量 */
  delivered: boolean | null
  /** 写了一半的话后面另起一行打斜杠：只列技能，不列命令；话中间的斜杠不弹单子 */
  mixed: { commands: number; skills: number; midText: boolean }
  /** 翻输入历史翻出一条斜杠开头的话：不弹单子 */
  recalled: { text: string; popup: boolean }
  /** /model：底栏上的模型选择器点开了，输入框里的触发词没了，选择器收起之后焦点回到输入框 */
  model: { opened: boolean; textCleared: boolean; focusBack: boolean }
  /** /terminal：终端面板开了，再来一次又收了。只在模拟核心上量 */
  terminal: { opened: boolean; closed: boolean } | null
  /**
   * /compact：多出压缩的那个回合。真实入口上的会话太小，Pi 不压：不开回合，
   * 出一条“没压缩成：原因”的提示（原因是对面的原话，不是空的）
   */
  compacted: boolean
  /** 请求卡片挂着的时候在输入框里打斜杠。只在模拟核心上量 */
  withCard: {
    popup: boolean
    /** 数字键、上下键、回车、Esc 都没有落到卡片上：卡片还在、没有哪一项被选中 */
    cardKept: boolean
    /** 上下键走的是单子，回车选的是单子里的 */
    moved: boolean
    chip: string
    /** Esc 关的是单子，卡片还在 */
    escClosed: boolean
    faults: string
  } | null
  /** 各种取不到的情形下技能那一组写的话。只在模拟核心上量 */
  states: {
    /** dsh：一项都没有 */
    empty: string
    /** 没有声明的原生 codex：不认识 */
    unsupported: string
    /** build-01 上“缓存目录配额”那个会话（工作目录 /var/cache/ci）：头一回没取到，有“再取一次”，取了之后列出来几项 */
    failed: string
    retryOffered: boolean
    retried: number
    /** 再取到的那一份里有一项没列出来：技能底下写的那句话，和鼠标停上去看的全文 */
    skipped: string
    skippedDetail: string
    /** 回到取过的那个会话再打斜杠：上次的那一份立刻就在，不用等 */
    cached: boolean
  } | null
  /** /new 到了新建对话页；那里的单子没有 /new 和 /compact，技能照样有，带着技能建出来的会话里第一条消息带着它 */
  fresh: {
    arrived: boolean
    commands: string[]
    skills: number
    chip: string
    mentions: string[]
    text: string
  }
}

export async function slashProbe(real: boolean): Promise<SlashProbe> {
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
    throw new Error(`命令和技能：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const turns = () => all('.turn').length
  const write = (target: HTMLTextAreaElement, words: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      target,
      words,
    )
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }
  const popup = () => one('.dock .sug')
  const rows = (kind: string) => all(`.dock .sug-opt[data-kind="${kind}"]`)
  const names = (kind: string) => rows(kind).map((row) => text(one('b', row)))
  const active = () => text(one('.dock .sug-opt[aria-selected="true"] b'))
  const note = () => text(one('.dock .sug [data-group="skills"] .sug-note'))
  const chips = () => all('.dock .cmp-chip').map((chip) => text(one('.ell', chip)))
  const idle = () => until('这一轮结束', () => !running() && !one('.req') && area(), 120_000)
  const open = async (title: string) => {
    const row = await until(`侧栏里的“${title}”`, () =>
      all('.ss-row').find((entry) => text(entry).includes(title)),
    )
    row.click()
    await until(`“${title}”的内容`, () => text(one('.crumb')).includes(title) && one('.turn'))
    await frame()
    const input = await until('输入框', area)
    if (input.value) write(input, '')
    for (const cross of all('.dock .cmp-chip-x')) cross.click()
    input.focus()
    await frame()
    return input
  }
  /** 打一段字，等单子出来（或者确认它没出来） */
  const type = async (input: HTMLTextAreaElement, words: string, expect = true) => {
    write(input, words)
    if (expect) await until(`“${words}”的单子`, popup, 5000)
    else await sleep(120)
    await frame()
  }
  /** 等技能那一组有了着落：列出来了，或者写了一句话 */
  const settled = () =>
    until('技能那一组有着落', () => rows('skill').length > 0 || (note() && !/…$/.test(note())))

  /** 单子摆得对不对 */
  const faults = (): string => {
    const found: string[] = []
    const box = popup()?.getBoundingClientRect()
    const cmp = one('.dock .cmp')?.getBoundingClientRect()
    const main = one('.main')?.getBoundingClientRect()
    if (!box || !cmp || !main) return '单子或者输入框不在'
    if (box.bottom > cmp.top + 0.5) found.push('单子压着输入框')
    if (box.top < main.top - 0.5) found.push('单子伸到了主区域上面')
    if (box.left < main.left - 0.5 || box.right > main.right + 0.5) found.push('单子伸到左右外面')
    for (const row of all('.dock .sug-opt')) {
      if (row.scrollWidth > row.clientWidth + 1) found.push(`“${text(one('b', row))}”那一行撑破了`)
    }
    const list = one('.dock .sug-list')
    if (list && list.scrollWidth > list.clientWidth + 1) found.push('单子里横向溢出')
    // 单子没有被别的东西盖住：选中那一行正中那一点上是它自己
    const row = one('.dock .sug-opt[aria-selected="true"]')
    const at = row?.getBoundingClientRect()
    if (row && at) {
      const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2)
      if (!hit || !row.contains(hit)) found.push('单子被盖住了')
    }
    return found.join('、')
  }

  const main = real ? '给首页加一个状态条' : '首页文案'
  const wanted = real ? 'fixture-notes' : 'code-review'
  const part = real ? 'note' : 'rev'
  let input = await open(main)
  await idle()

  // ---- 一、打斜杠，单子出来 ----
  const startedAt = performance.now()
  write(input, '/')
  await until('单子', popup, 5000)
  const openMs = performance.now() - startedAt
  const loadingSeen = real ? null : rows('skill').length === 0 && /…$/.test(note())
  await until('技能列出来', () => rows('skill').length > 0)
  const skillsMs = performance.now() - startedAt
  await frame()
  const commands = names('command')
  const skills = names('skill')
  const footShown = text(one('.dock .sug-foot-note')).length > 0
  const placed = faults()

  // ---- 二、按键归单子 ----
  const first = active()
  const downEvent = press(input, 'ArrowDown')
  await frame()
  const second = active()
  const upEvent = press(input, 'ArrowUp')
  await frame()
  const backToFirst = active() === first
  press(input, 'ArrowUp')
  await frame()
  const last = active()
  const everyone = [...commands, ...skills]
  const keys: SlashProbe['keys'] = {
    down: first === everyone[0] && second === everyone[1],
    up: backToFirst,
    wrap: last === everyone[everyone.length - 1],
    held: downEvent.defaultPrevented && upEvent.defaultPrevented,
    textKept: input.value === '/' && input.selectionStart === 1,
  }

  // ---- 三、接着打字是过滤；对不上的说一声 ----
  await type(input, `/${part}`)
  const filtered = [...names('command'), ...names('skill')]
  await type(input, '/zzzq')
  await until('“没有叫这个的”', () => text(one('.dock .sug-list > .sug-note')), 5000).catch(
    () => null,
  )
  const noneSaid = text(one('.dock .sug-list > .sug-note'))

  // ---- 四、Esc ----
  await type(input, `/${part}`)
  const escEvent = press(input, 'Escape')
  await frame()
  const esc: SlashProbe['esc'] = {
    closed: !popup() && escEvent.defaultPrevented,
    textKept: input.value === `/${part}`,
    stayedClosed: false,
    reopened: false,
  }
  await type(input, `/${part}x`, false)
  esc.stayedClosed = !popup()
  write(input, '')
  await frame()
  await type(input, '/')
  esc.reopened = Boolean(popup())

  // ---- 五、选中技能：回车、Tab、鼠标 ----
  await type(input, `/${part}`)
  press(input, 'Enter')
  await until('技能的那一片', () => chips().length === 1, 5000)
  const picked: SlashProbe['picked'] = {
    chip: chips()[0] ?? '',
    textCleared: input.value === '' && !popup(),
    focusKept: document.activeElement === input,
  }
  await type(input, `/${part}`)
  press(input, 'Enter')
  await sleep(150)
  const same = chips().length === 1
  one<HTMLButtonElement>('.dock .cmp-chip-x')?.click()
  await until('片拿掉', () => chips().length === 0, 5000).catch(() => null)
  const removed = chips().length === 0
  input.focus()
  await type(input, `/${part}`)
  press(input, 'Tab')
  await until('Tab 选中的那一片', () => chips().length === 1, 5000).catch(() => null)
  const byTab = chips()[0] ?? ''
  one<HTMLButtonElement>('.dock .cmp-chip-x')?.click()
  await until('片拿掉', () => chips().length === 0, 5000).catch(() => null)
  input.focus()
  await type(input, '/')
  const target = await until('要点的那一行', () =>
    rows('skill').find((row) => text(one('b', row)) === `/${wanted}`),
  )
  const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
  target.dispatchEvent(down)
  target.click()
  await until('点中的那一片', () => chips().length === 1, 5000).catch(() => null)
  const again: SlashProbe['again'] = {
    same,
    byTab,
    byClick: chips()[0] ?? '',
    mouseHeld: down.defaultPrevented && document.activeElement === input,
  }

  // ---- 六、带着技能发出去 ----
  const words = '看一下这次改动'
  write(input, words)
  await frame()
  press(input, 'Enter')
  // 对面回显的那一条可能和发出去的不一样（引擎把技能化成了文字）：按“里面有这句话”找，等回合结束再读
  const said = () =>
    all('.umsg').findLast((entry) => text(one('.umsg-text', entry)).includes(words))
  await until('带着技能的那条消息', said)
  await idle()
  const bubble = said()
  const sent: SlashProbe['sent'] = {
    mentions: bubble ? all('.atts .mention', bubble).map(text) : [],
    text: text(bubble ? one('.umsg-text', bubble) : null).slice(0, 400),
    cleared: chips().length === 0 && input.value === '',
  }
  const delivered = real ? text(all('.turn').at(-1)).includes('LITCH-SKILL-7391') : null

  // ---- 七、夹在话里的；翻输入历史翻出来的 ----
  input = await until('输入框', area)
  input.focus()
  await type(input, '写了一半\n/')
  await settled()
  const mixed: SlashProbe['mixed'] = {
    commands: rows('command').length,
    skills: rows('skill').length,
    midText: false,
  }
  await type(input, '看一下 /', false)
  mixed.midText = !popup()
  write(input, '')
  await frame()
  // 对不上任何一项的时候回车照常发送；它成了一条斜杠开头的输入历史
  let recalled: SlashProbe['recalled'] = { text: '', popup: false }
  if (!real) {
    await type(input, '/zzzq')
    press(input, 'Enter')
    await until('“/zzzq”发出去', () => all('.umsg-text').some((entry) => text(entry) === '/zzzq'))
    await idle()
    input = await until('输入框', area)
    input.focus()
    input.setSelectionRange(0, 0)
    press(input, 'ArrowUp')
    await sleep(150)
    recalled = { text: input.value, popup: Boolean(popup()) }
    press(input, 'ArrowDown')
    await frame()
    if (input.value) write(input, '')
  }

  // ---- 八、内建命令：/model、/terminal、/compact ----
  const model: SlashProbe['model'] = { opened: false, textCleared: false, focusBack: false }
  if (commands.includes('/model')) {
    await type(input, '/model')
    press(input, 'Enter')
    const button = () => one('.dock .pick[data-kind="model"] .pick-btn')
    await until('模型选择器点开', () => button()?.getAttribute('aria-expanded') === 'true', 5000)
    model.opened = true
    model.textCleared = input.value === ''
    press(document.activeElement ?? document.body, 'Escape')
    await until('模型选择器收起', () => button()?.getAttribute('aria-expanded') !== 'true', 5000)
    await until('焦点回到输入框', () => document.activeElement === input, 2000).catch(() => null)
    model.focusBack = document.activeElement === input
  }
  let terminal: SlashProbe['terminal'] = null
  if (!real) {
    const shown = () => {
      const panel = one('.term-dock')
      return Boolean(panel && !panel.hidden && panel.getBoundingClientRect().height > 0)
    }
    const before = shown()
    input.focus()
    await type(input, '/terminal')
    press(input, 'Enter')
    await until('终端面板换了开合', () => shown() !== before, 5000).catch(() => null)
    const opened = shown() !== before
    // 紧挨着的两次开合会被当成同一次按键，隔一会儿
    await sleep(300)
    input = await until('输入框', area)
    input.focus()
    await type(input, '/terminal')
    press(input, 'Enter')
    await until('终端面板换回去', () => shown() === before, 5000).catch(() => null)
    terminal = { opened, closed: shown() === before }
    await sleep(300)
    input = await until('输入框', area)
    input.focus()
  }
  const turnsBefore = turns()
  await type(input, '/compact')
  press(input, 'Enter')
  const refusal = () => text(one('[data-toast="compact-failed"] .toast-text'))
  await until(
    '压缩的那个回合，或者没压成的提示',
    () => turns() > turnsBefore || (real && refusal()),
    30_000,
  ).catch(() => null)
  const told = refusal()
  // 没压的：再等一会儿，确认后面也没有冒出回合来
  if (real && told) await sleep(1_500)
  const compacted =
    input.value === '' &&
    (real && told
      ? turns() === turnsBefore &&
        /^没压缩成：\S/.test(told) &&
        // 原因是对面给的，不是界面说不出原因时的套话（packages/ui 的 error.*、ability.unsupported）
        !/出了点问题|设备没有|已取消|不支持这个操作/.test(told)
      : turns() === turnsBefore + 1)
  one<HTMLButtonElement>('[data-toast="compact-failed"] .toast-x')?.click()
  await idle()

  // ---- 九、请求卡片挂着的时候 ----
  let withCard: SlashProbe['withCard'] = null
  if (!real) {
    input = await until('输入框', area)
    input.focus()
    write(input, '问一句就行')
    await frame()
    press(input, 'Enter')
    const card = await until(
      '提问卡片',
      () => (all('.req .opt').length > 0 ? one<HTMLElement>('.req') : null),
      60_000,
    )
    await frame()
    const untouched = () =>
      one('.req') === card &&
      all('.req .opt').every((option) => option.getAttribute('aria-checked') !== 'true')
    input.focus()
    await type(input, '/')
    await settled()
    const shown = Boolean(popup())
    const cardFaults = faults()
    const before = active()
    press(input, '1')
    press(input, '2')
    press(input, 'ArrowDown')
    await sleep(350)
    const moved = active() !== before && active() !== ''
    let kept = untouched()
    await type(input, `/${part}`)
    press(input, 'Enter')
    await until('技能的那一片', () => chips().length === 1, 5000).catch(() => null)
    await sleep(350)
    kept &&= untouched()
    const chip = chips()[0] ?? ''
    await type(input, '/')
    press(input, 'Escape')
    await sleep(350)
    const escClosed = !popup() && untouched()
    withCard = { popup: shown, cardKept: kept, moved, chip, escClosed, faults: cardFaults }
    write(input, '')
    one<HTMLButtonElement>('.dock .cmp-chip-x')?.click()
    await frame()
    card.focus()
    press(card, '2')
    await until('提问卡片消失', () => !one('.req'), 60_000)
    await idle()
  }

  // ---- 十、取不到的几种情形 ----
  let states: SlashProbe['states'] = null
  if (!real) {
    const said = async (title: string) => {
      const field = await open(title)
      await type(field, '/')
      await settled()
      return field
    }
    await said('设备进程的转发开销基准')
    const empty = note()
    await said('整理快照保留策略')
    const unsupported = note()
    const flaky = await said('缓存目录配额')
    const failed = note()
    const retry = one('.dock .sug-opt[data-kind="again"]')
    // “再取一次”是单子里的一行：用键盘走到它上面按回车
    for (
      let step = 0;
      retry && step < 12 && retry.getAttribute('aria-selected') !== 'true';
      step++
    ) {
      press(flaky, 'ArrowDown')
      await frame()
    }
    if (retry) press(flaky, 'Enter')
    await until('再取一次之后的技能', () => rows('skill').length > 0, 10_000).catch(() => null)
    const retried = rows('skill').length
    const skipped = note()
    const skippedDetail =
      one('.dock .sug [data-group="skills"] .sug-note')?.getAttribute('title') ?? ''
    write(flaky, '')
    // 回到取过的那个会话：上次的那一份立刻就在
    input = await open(main)
    write(input, '/')
    await until('单子', popup, 5000)
    const cached = rows('skill').length > 0
    states = {
      empty,
      unsupported,
      failed,
      retryOffered: Boolean(retry),
      retried,
      skipped,
      skippedDetail,
      cached,
    }
    write(input, '')
    await frame()
  }

  // ---- 十一、/new 和新建对话页 ----
  input = await open(main)
  await type(input, '/new')
  press(input, 'Enter')
  const arrived = Boolean(
    await until('新建对话页', () => one('.new-page .new-hero') && area(), 10_000).catch(() => null),
  )
  const fresh: SlashProbe['fresh'] = {
    arrived,
    commands: [],
    skills: 0,
    chip: '',
    mentions: [],
    text: '',
  }
  if (arrived) {
    input = await until('新建对话页的输入框', area)
    if (input.value) write(input, '')
    input.focus()
    await type(input, '/')
    await settled()
    fresh.commands = names('command')
    fresh.skills = rows('skill').length
    rows('skill')[0]?.click()
    await until('技能的那一片', () => chips().length === 1, 5000).catch(() => null)
    fresh.chip = chips()[0] ?? ''
    const opening = '带着技能开的头'
    write(input, opening)
    await frame()
    press(input, 'Enter')
    const head = () =>
      one('.new-page')
        ? null
        : all('.umsg').find((entry) => text(one('.umsg-text', entry)).includes(opening))
    await until('新会话的第一条消息', head, 60_000)
    await idle()
    const shown = head()
    fresh.mentions = shown ? all('.atts .mention', shown).map(text) : []
    fresh.text = text(shown ? one('.umsg-text', shown) : null).slice(0, 400)
  }

  return {
    openMs: Math.round(openMs * 10) / 10,
    skillsMs: Math.round(skillsMs),
    loadingSeen,
    commands,
    skills,
    footShown,
    faults: placed,
    keys,
    filtered,
    noneSaid,
    esc,
    picked,
    again,
    removed,
    sent,
    delivered,
    mixed,
    recalled,
    model,
    terminal,
    compacted,
    withCard,
    states,
    fresh,
  }
}

export interface SlashLook {
  /** 量的时候窗口里面有多宽、多高 */
  width: number
  height: number
  /**
   * 一种一行：“语言/皮肤/明暗｜横向溢出的像素｜版面出的岔子（没有就是空的）｜
   * 对比度，依次是：行上的名字、行上的说明、选中那一行的名字、分组的小标题、底下那一栏、片上的字”
   */
  layouts: string[]
}

/** sheet：量哪一张单子。slash 是命令和技能的，at 是找文件的（同一个组件，条目和片不一样） */
export async function slashLook(sheet: 'slash' | 'at' = 'slash'): Promise<SlashLook> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  // 单子上要走到的那一种条目，和先带上一片、再把单子打开时各打什么
  const kind = sheet === 'at' ? 'file' : 'skill'
  const first = sheet === 'at' ? '@serve' : '/rev'
  const again = sheet === 'at' ? '@s' : '/'
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
    throw new Error(`单子的样子（${sheet}）：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const write = (target: HTMLTextAreaElement, words: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      target,
      words,
    )
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: EventTarget, key: string) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))

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
  const input = await until('输入框', area)
  for (const cross of all('.dock .cmp-chip-x')) cross.click()
  input.focus()
  // 先带上一片，再把单子打开，走到头一项技能（或者文件）上：底下那一栏这时有来源和位置
  write(input, first)
  await until('单子', () => one(`.dock .sug-opt[data-kind="${kind}"]`))
  press(input, 'Enter')
  await until('带上的那一片', () => one('.dock .cmp-chip'))
  /** 把单子打开，走到头一项技能（或者文件）上（换语言之后输入区可能是新的一份，重新来一遍） */
  const show = async () => {
    const field = await until('输入框', area)
    field.focus()
    write(field, '')
    write(field, again)
    await until('单子', () => one(`.dock .sug-opt[data-kind="${kind}"]`))
    for (let step = 0; step < 12; step++) {
      if (one(`.dock .sug-opt[data-kind="${kind}"][aria-selected="true"]`)) break
      press(field, 'ArrowDown')
      await frame()
    }
    await until('底下那一栏的位置', () => one('.dock .sug-fact'))
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
        one('.dock .sug-list'),
        one('.dock .sug-foot'),
        one('.dock .cmp-atts'),
        // 底栏：这个会话上模型、强度、权限、计划模式的开关都在，最窄的窗口里也要放得下
        one('.dock .cmp-bar'),
        ...all('.dock .sug-opt'),
        ...all('.dock .sug-fact'),
        ...all('.dock .cmp-chip'),
      ].map((box) => (box ? box.scrollWidth - box.clientWidth : 0)),
    )
  const faults = () => {
    const found: string[] = []
    const box = one('.dock .sug')?.getBoundingClientRect()
    const cmp = one('.dock .cmp')?.getBoundingClientRect()
    const main = one('.main')?.getBoundingClientRect()
    if (!box || !cmp || !main) return '单子或者输入框不在'
    if (box.bottom > cmp.top + 0.5) found.push('单子压着输入框')
    if (box.top < main.top - 0.5) found.push('单子伸到了主区域上面')
    if (box.left < main.left - 0.5 || box.right > main.right + 0.5) found.push('单子伸到左右外面')
    const foot = one('.dock .sug-foot')?.getBoundingClientRect()
    if (!foot || foot.bottom > box.bottom + 0.5 || foot.top < box.top - 0.5) {
      found.push('底下那一栏不在单子里')
    }
    for (const fact of all('.dock .sug-fact')) {
      const at = fact.getBoundingClientRect()
      if (at.right > box.right + 0.5) found.push('底下那一栏里的字伸到单子外面')
    }
    const chip = one('.dock .cmp-chip')?.getBoundingClientRect()
    if (!chip || chip.left < cmp.left - 0.5 || chip.right > cmp.right + 0.5) {
      found.push('片不在输入区里')
    }
    const picked = one('.dock .sug-opt[aria-selected="true"]')
    const at = picked?.getBoundingClientRect()
    if (!picked || !at) found.push('没有选中的那一行')
    else {
      const hit = document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2)
      if (!hit || !picked.contains(hit)) found.push('选中的那一行被盖住了')
    }
    return found.join('、')
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
        // 换了皮肤行高会变，选中的那一行可能滚出去了：走开再走回来，让单子把它滚进来
        const field = area()
        if (field) {
          press(field, 'ArrowDown')
          press(field, 'ArrowUp')
          await frame()
          await frame()
        }
        const numbers = [
          readable('.dock .sug-opt:not([aria-selected="true"]) b'),
          readable('.dock .sug-opt:not([aria-selected="true"]) span'),
          readable('.dock .sug-opt[aria-selected="true"] b'),
          readable('.dock .sug-head'),
          readable('.dock .sug-foot-note'),
          readable('.dock .cmp-chip .ell'),
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
  const field = area()
  if (field) write(field, '')
  one<HTMLButtonElement>('.dock .cmp-chip-x')?.click()
  await sleep(100)
  return { width: window.innerWidth, height: window.innerHeight, layouts }
}

/** look 只在模拟核心上有：wide 是平常大小的窗口里量的，narrow 是缩到允许的最小之后量的 */
export function judgeSlash(
  probe: SlashProbe,
  real: boolean,
  look: { wide: SlashLook; narrow: SlashLook } | null,
): string[] {
  const failed: string[] = []
  const wanted = real ? '/fixture-notes' : '/code-review'
  const check = (ok: boolean, what: string) => {
    if (!ok) failed.push(`命令和技能：${what}`)
  }
  check(probe.openMs < 100, `打下斜杠 ${probe.openMs} 毫秒单子才出来`)
  check(probe.skillsMs < 3000, `技能 ${probe.skillsMs} 毫秒才列出来`)
  if (!real) check(probe.loadingSeen === true, '头一回取技能的时候没有写“正在取”')
  for (const name of ['/new', '/compact', '/terminal']) {
    check(probe.commands.includes(name), `单子上没有 ${name}（有的是 ${probe.commands.join(' ')}）`)
  }
  check(probe.skills.includes(wanted), `单子上没有 ${wanted}（有的是 ${probe.skills.join(' ')}）`)
  if (!real) check(probe.skills.length === 6, `该列 6 项技能，列了 ${probe.skills.length} 项`)
  check(probe.footShown, '单子底下那一栏没有写选中那一项的说明')
  check(probe.faults === '', `单子摆得不对：${probe.faults}`)
  for (const [name, ok] of Object.entries(probe.keys)) check(ok, `按键不对（${name}）`)
  check(
    probe.filtered.length === 1 && probe.filtered[0] === wanted,
    `过滤之后该只剩 ${wanted}，实际是 ${probe.filtered.join(' ') || '空的'}`,
  )
  check(probe.noneSaid.length > 0, '什么都对不上的时候单子上没有说')
  for (const [name, ok] of Object.entries(probe.esc)) check(ok, `Esc 不对（${name}）`)
  check(probe.picked.chip === wanted, `回车选中之后的片不对：“${probe.picked.chip}”`)
  check(probe.picked.textCleared, '选中之后触发词还在，或者单子还开着')
  check(probe.picked.focusKept, '选中之后焦点不在输入框里')
  check(probe.again.same, '同一项技能选了两遍，带了两片')
  check(probe.again.byTab === wanted, `Tab 选中的片不对：“${probe.again.byTab}”`)
  check(probe.again.byClick === wanted, `鼠标点中的片不对：“${probe.again.byClick}”`)
  check(probe.again.mouseHeld, '鼠标按在单子上把输入框的焦点带走了')
  check(probe.removed, '片拿不掉')
  // 模拟核心照发出去的样子回显；真实入口的 Pi 把技能化成了文字，回显的是化完之后的那一段
  check(
    real
      ? probe.sent.text.includes('看一下这次改动')
      : probe.sent.mentions.includes(wanted.slice(1)) && probe.sent.text === '看一下这次改动',
    `带着技能发出去的消息不对：${JSON.stringify(probe.sent)}`,
  )
  check(probe.sent.cleared, '发出去之后输入区里的片还在')
  if (real) check(probe.delivered === true, '技能没有到模型手里（回话里没有技能正文的记号）')
  check(probe.mixed.commands === 0, '写了一半的话后面打斜杠，单子上还列着命令')
  check(probe.mixed.skills > 0, '写了一半的话后面打斜杠，单子上没有技能')
  check(probe.mixed.midText, '话中间的斜杠弹了单子')
  if (!real) {
    check(probe.recalled.text === '/zzzq', `没有翻出那条输入历史：“${probe.recalled.text}”`)
    check(!probe.recalled.popup, '翻输入历史翻出斜杠开头的话，弹了单子')
  }
  if (probe.commands.includes('/model')) {
    for (const [name, ok] of Object.entries(probe.model)) check(ok, `/model 不对（${name}）`)
  }
  if (probe.terminal) {
    check(probe.terminal.opened && probe.terminal.closed, '/terminal 没有开合终端面板')
  }
  check(probe.compacted, '/compact 没有压缩')
  const card = probe.withCard
  if (card) {
    check(card.popup, '请求卡片挂着的时候单子出不来')
    check(card.cardKept, '请求卡片挂着的时候，单子的按键落到了卡片上')
    check(card.moved, '请求卡片挂着的时候，上下键没有在单子里走')
    check(card.chip === wanted, `请求卡片挂着的时候回车选中的片不对：“${card.chip}”`)
    check(card.escClosed, '请求卡片挂着的时候，Esc 没有只关单子')
    check(card.faults === '', `请求卡片挂着的时候单子摆得不对：${card.faults}`)
  }
  const states = probe.states
  if (states) {
    check(states.empty === '这里没有技能', `dsh 上该写没有技能，写的是“${states.empty}”`)
    check(
      states.unsupported === '这个 harness 带不了技能',
      `没有声明的 codex 上写的是“${states.unsupported}”`,
    )
    check(states.failed.startsWith('技能没取到：'), `没取到时写的是“${states.failed}”`)
    check(states.retryOffered, '没取到时没有“再取一次”')
    check(states.retried === 6, `再取一次之后该有 6 项，有 ${states.retried} 项`)
    check(
      states.skipped === '有 1 项没列出来：开头的元数据里没有 description',
      `有一项没列出来时写的是“${states.skipped}”`,
    )
    check(
      states.skippedDetail.includes('/var/cache/ci/.agents/skills/prune-cache/SKILL.md'),
      `没列出来的那一项，鼠标停上去看不到它的位置：“${states.skippedDetail}”`,
    )
    check(states.cached, '回到取过的会话，上次的技能没有立刻在')
  }
  const fresh = probe.fresh
  check(fresh.arrived, '/new 没有到新建对话页')
  check(
    !fresh.commands.includes('/new') && !fresh.commands.includes('/compact'),
    `新建对话页的单子上不该有 /new 和 /compact：${fresh.commands.join(' ')}`,
  )
  check(fresh.commands.includes('/terminal'), '新建对话页的单子上没有 /terminal')
  check(fresh.skills > 0, '新建对话页的单子上没有技能')
  check(
    fresh.chip !== '' &&
      fresh.text.includes('带着技能开的头') &&
      (real || fresh.mentions.includes(fresh.chip.slice(1))),
    `带着技能建的会话，第一条消息不对：${JSON.stringify(fresh)}`,
  )
  failed.push(...judgeSheetLook('命令和技能', look))
  return failed
}

/** 一张单子的样子合不合格：两种窗口大小各 12 种（两种语言乘三种皮肤的深浅色），不溢出、不出岔子、字和底色分得开 */
export function judgeSheetLook(
  sheet: string,
  look: { wide: SlashLook; narrow: SlashLook } | null,
): string[] {
  const failed: string[] = []
  for (const [name, one] of look
    ? ([
        ['平常大小', look.wide],
        ['最小的窗口', look.narrow],
      ] as const)
    : []) {
    if (one.layouts.length !== 12)
      failed.push(`${sheet}的样子（${name}）：该量 12 种，量了 ${one.layouts.length} 种`)
    for (const line of one.layouts) {
      const [which = '', spill = '', faults = '', numbers = ''] = line.split('｜')
      if (spill !== '0') failed.push(`${sheet}的样子（${name} ${which}）：横向溢出 ${spill} 像素`)
      if (faults) failed.push(`${sheet}的样子（${name} ${which}）：${faults}`)
      const [title = 0, note = 0, picked = 0, head = 0, foot = 0, chip = 0] = numbers
        .split(':')
        .map(Number)
      // 正文一样要读的字 4.5 起，淡下去的说明和小标题 3 起
      for (const [label, value, least] of [
        ['行上的名字', title, 4.5],
        ['行上的说明', note, 3],
        ['选中那一行的名字', picked, 4.5],
        ['分组的小标题', head, 3],
        ['底下那一栏', foot, 4.5],
        ['片上的字', chip, 4.5],
      ] as const) {
        if (value < least) {
          failed.push(`${sheet}的样子（${name} ${which}）：${label}和底色分不开（${value}）`)
        }
      }
    }
  }
  return failed
}
