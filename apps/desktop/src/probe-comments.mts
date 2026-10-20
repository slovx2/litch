// 选中回答文字加评论的验收（packages/ui/src/transcript/comments/）：选区上的浮层、编辑框、输入框上的片、
// 原文上的底色和记号、直接发送、对话里的评论卡片、回答里的“评论 N”、跳原文、条数上限、重开之后草稿还在。
// 只对着模拟核心量：发的话里带“评论”时模拟核心回一段能选字的（过程里一段说明、一条命令，最终回答里有段落、
// 代码块和表格），消息带着评论时逐条回应、用 [N] 标号，末尾多写一个超出条数的编号。
// 接在输入区那一组后面，在同一个窗口里跑；commentsProbe 留下一条草稿，外面重新加载页面之后由 commentsReloaded 看它还在不在。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。

/** 验收用的会话 */
export const COMMENT_SESSION = '远程设备安装指引'

export interface CommentsProbe {
  /** 选中回答里的一段：浮层出来了、在选区上面、两个按钮 */
  pop: { shown: boolean; above: boolean; buttons: string[] }
  /** 选中用户消息、过程里那条命令的字：不出浮层 */
  refused: { user: boolean; command: boolean }
  /** 从过程里的说明一直选到最终回答：只取开头那条，选区缩到那条里面 */
  across: { shown: boolean; clipped: boolean }
  /** 编辑框：焦点在评论框里，引用对，Shift+回车不加，Esc 不加 */
  editor: { focused: boolean; quote: boolean; shiftKept: boolean; escDropped: boolean }
  /** 回车加进去：片（编号、引用开头、评论开头），原文上的底色和记号 */
  added: { chips: string[]; marked: string[]; badges: string[] }
  /** 点片：编辑框贴着片在它上面，改评论生效，定位原文闪了，点记号也打开编辑框 */
  chipEdit: { above: boolean; saved: boolean; located: boolean; badgeOpens: boolean }
  /** ⌘回车直接发：对话里多了一条只带这一条评论的消息，输入框里的字和别的评论没动 */
  direct: { cards: number; textKept: boolean; chipsKept: number }
  /** 一起发出去：卡片两张、下面是打的字；片、底色、记号都没了 */
  sent: { cards: string[]; rest: string; cleared: boolean; unmarked: boolean }
  /** 回答里的 [N]：画成记号的、照原文的；悬停看得到引用；点了跳原文闪一下 */
  cites: { marks: string[]; literal: boolean; peek: boolean; flashed: string }
  /** 点卡片跳原文：原文在收起的过程里时替它打开 */
  card: { reopened: boolean; flashed: string }
  /** 十条之后浮层上的“评论”点不了 */
  full: boolean
}

export async function commentsProbe(session: string): Promise<CommentsProbe> {
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
    throw new Error(`评论：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const running = () => Boolean(one('.running-line'))
  const idle = () => until('这一轮结束', () => !running() && area(), 60_000)
  const write = (target: HTMLTextAreaElement, words: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      target,
      words,
    )
    target.setSelectionRange(words.length, words.length)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (target: EventTarget, key: string, extra: KeyboardEventInit = {}) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }),
    )
  const chips = () => all('.dock .cmt-chip')
  const pop = () => one('.cmt-pop')
  const editor = () => one('.cmt-edit')
  const note = () => one<HTMLTextAreaElement>('.cmt-edit-text')
  const marked = () => [...(CSS.highlights.get('litch-comment') ?? [])].map(String)
  const flashed = () => [...(CSS.highlights.get('litch-comment-flash') ?? [])].map(String)
  /** 一个元素里含着 word 的那个文字节点，和 word 在里面的位置 */
  const textAt = (root: Element, word: string): [Text, number] => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node as Text).data.indexOf(word)
      if (at >= 0) return [node as Text, at]
    }
    throw new Error(`评论：找不到“${word}”`)
  }
  /** 像拿鼠标选字一样：定下选区，在那里松开鼠标 */
  const select = async (from: [Text, number], to: [Text, number]) => {
    const range = document.createRange()
    range.setStart(from[0], from[1])
    range.setEnd(to[0], to[1])
    const selection = getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    to[0].parentElement?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    await sleep(30)
    await frame()
  }
  const selectWord = async (root: Element, word: string) => {
    const [node, at] = textAt(root, word)
    await select([node, at], [node, at + word.length])
  }
  const clearSelection = async () => {
    getSelection()?.removeAllRanges()
    await frame()
  }
  /** 选中 word，点“评论”，写上 words，按 key（Enter、或者带 ⌘ 的 Enter） */
  /** 从 word 的开头选到 end 的末尾（代码块里上了色，几个词各在各的节点里）；不给 end 就只选 word */
  const comment = async (root: Element, word: string, words: string, meta = false, end = '') => {
    if (end) {
      const [endNode, endAt] = textAt(root, end)
      await select(textAt(root, word), [endNode, endAt + end.length])
    } else await selectWord(root, word)
    const button = await until('浮层上的“评论”', () =>
      one<HTMLButtonElement>('.cmt-pop [data-act="comment"]'),
    )
    button.click()
    const field = await until('评论框', () => (document.activeElement === note() ? note() : null))
    write(field, words)
    await frame()
    press(field, 'Enter', meta ? { metaKey: true } : {})
    await until('编辑框关上', () => !editor())
    await clearSelection()
  }
  const lastTurn = () => all('.main .tr .turn').at(-1)
  const finalAnswer = () => {
    const turn = lastTurn()
    return turn ? all(':scope > [data-comment-item]', turn).at(-1) : undefined
  }

  // 打开会话、清掉上一次留下的片
  const row = await until(`侧栏里的“${session}”`, () =>
    all('.ss-row').find((entry) => text(entry).includes(session)),
  )
  row.click()
  await until(`“${session}”的内容`, () => text(one('.crumb')).includes(session) && area())
  await idle()
  for (const cross of all('.dock .cmp-chip-x')) cross.click()
  const field = await until('输入框', area)
  write(field, '给我一段能评论的回答')
  await frame()
  press(field, 'Enter')
  await until('能评论的回答', () => text(finalAnswer()).includes('另外') && !running(), 30_000)
  await idle()
  const answer = await until('最终回答', finalAnswer)

  // 一、选中回答里的一段：浮层在选区上面
  await selectWord(answer, '每次立刻重来')
  const shown = await until('浮层', pop).then(
    () => true,
    () => false,
  )
  const range = getSelection()?.getRangeAt(0).getBoundingClientRect()
  const popBox = pop()?.getBoundingClientRect()
  const popResult = {
    shown,
    above: Boolean(range && popBox && popBox.bottom <= range.top + 1),
    buttons: all('.cmt-pop button').map((button) => button.dataset.act ?? ''),
  }
  await clearSelection()

  // 二、用户消息、命令输出里选字不出浮层
  const user = all('.main .tr .umsg-text').at(-1)
  if (user) await selectWord(user, '评论')
  await sleep(60)
  const userRefused = !pop()
  await clearSelection()
  const head = one<HTMLButtonElement>('.proc-head', lastTurn())
  if (head?.getAttribute('aria-expanded') === 'false') head.click()
  const noteRoot = await until('过程里的说明', () =>
    one('.proc-body [data-comment-item]', lastTurn()),
  )
  // 命令那一组、那一条点开看输出
  one<HTMLElement>('.proc-body .steps-head', lastTurn())?.click()
  await frame()
  ;(await until('命令那一条', () => one<HTMLElement>('.proc-body .item-head', lastTurn()))).click()
  const command = await until('命令的输出', () => one('.proc-body .item-detail', lastTurn()))
  await selectWord(command, 'retry')
  await sleep(60)
  const commandRefused = !pop()
  await clearSelection()

  // 三、跨了两条：只取开头那条
  const [noteNode, noteAt] = textAt(noteRoot, '再决定')
  const [answerNode] = textAt(answer, '每次立刻重来')
  await select([noteNode, noteAt], [answerNode, 3])
  const acrossShown = Boolean(await until('跨条的浮层', pop).catch(() => null))
  const acrossText = getSelection()?.toString() ?? ''
  const across = {
    shown: acrossShown,
    clipped: acrossText.includes('再决定') && !acrossText.includes('重试'),
  }
  await clearSelection()

  // 四、编辑框：焦点、引用、Shift+回车、Esc
  await selectWord(answer, '每次立刻重来')
  ;(await until('“评论”', () => one<HTMLButtonElement>('.cmt-pop [data-act="comment"]'))).click()
  const focusedField = await until('评论框拿到焦点', () =>
    document.activeElement === note() ? note() : null,
  ).catch(() => null)
  const quoteOk = text(one('.cmt-edit-quote')) === '每次立刻重来'
  if (focusedField) press(focusedField, 'Enter', { shiftKey: true })
  await frame()
  const shiftKept = Boolean(editor()) && chips().length === 0
  if (focusedField) press(focusedField, 'Escape')
  await frame()
  const escDropped = !editor() && chips().length === 0
  await clearSelection()

  // 五、加两条：一条带评论，一条（代码块里的）不带
  await comment(answer, '每次立刻重来', '为什么是三次？')
  const code = await until('代码块', () => one('.code', answer))
  await comment(code, 'const', '', false, 'delay')
  await until('两片', () => chips().length === 2)
  await until('原文上的两处底色', () => marked().length === 2)
  const added = {
    chips: chips().map((chip) => text(one('.cmp-chip-open', chip))),
    marked: marked(),
    badges: all('.main .tr .cmt-badge').map((badge) => text(badge)),
  }

  // 六、点片改评论、定位原文；点记号也打开编辑框
  const first = chips()[0]
  one<HTMLButtonElement>('.cmp-chip-open', first)?.click()
  const chipEditor = await until('片旁边的编辑框', editor)
  const above =
    chipEditor.getBoundingClientRect().bottom <= (first?.getBoundingClientRect().top ?? 0) + 1
  const editField = await until('评论框', () => (document.activeElement === note() ? note() : null))
  one<HTMLButtonElement>('.cmt-edit [data-act="locate"]')?.click()
  const located = Boolean(
    await until('原文闪一下', () => flashed().includes('每次立刻重来')).catch(() => null),
  )
  editField.focus()
  write(editField, '为什么固定三次？')
  await frame()
  press(editField, 'Enter')
  await until('编辑框关上', () => !editor())
  const saved = text(one('.cmt-chip-note', chips()[0])) === '为什么固定三次？'
  const badge = one<HTMLButtonElement>('.main .tr .cmt-badge')
  badge?.click()
  const badgeOpens = Boolean(await until('记号打开的编辑框', editor).catch(() => null))
  press(note() ?? document, 'Escape')
  await until('编辑框关上', () => !editor())

  // 七、⌘回车：只发这一条（过程里的说明），输入框里的字和别的评论不动
  write(field, '还没写完的话')
  const turnsBefore = all('.main .tr .turn').length
  await comment(noteRoot, '重试逻辑', '这条直接发', true)
  await until('直接发出去的那一条', () => all('.main .tr .turn').length > turnsBefore)
  await idle()
  const directCards = all('.ucmt', lastTurn()).length
  const direct = {
    cards: directCards,
    textKept: area()?.value === '还没写完的话',
    chipsKept: chips().length,
  }

  // 八、一起发出去
  const sentBefore = all('.main .tr .turn').length
  press(field, 'Enter')
  await until('发出去的那一条', () => all('.main .tr .turn').length > sentBefore)
  await frame()
  const sentTurn = lastTurn()
  const sent = {
    cards: all('.ucmt', sentTurn).map((card) => text(card)),
    rest: text(one('.umsg-text', sentTurn)),
    cleared: chips().length === 0 && area()?.value === '',
    unmarked: marked().length === 0 && all('.main .tr .cmt-badge').length === 0,
  }
  await idle()
  await until('回应里的记号', () => all('.cmt-cite', lastTurn()).length >= 2)

  // 九、回答里的 [N]
  const cites = all('.cmt-cite', lastTurn())
  const reply = text(finalAnswer())
  cites[0]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  const peek = Boolean(
    await until('悬停卡片', () => text(one('.cmt-peek')).includes('每次立刻重来')).catch(
      () => null,
    ),
  )
  cites[0]?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
  cites[1]?.click()
  const citeFlash = await until('点记号闪一下', () => flashed()[0]).catch(() => '')
  const citesResult = {
    marks: cites.map((cite) => text(cite)),
    literal: reply.includes('[3]'),
    peek,
    flashed: citeFlash,
  }

  // 十、点卡片：原文在收起的过程里，替它打开再闪
  await sleep(1700)
  const directTurn = all('.main .tr .turn').at(-2)
  const processHead = all('.proc-head').find(
    (element) => element.closest('.turn') === all('.main .tr .turn').at(-3),
  )
  if (processHead?.getAttribute('aria-expanded') === 'true') processHead.click()
  await until(
    '过程收起',
    () => !one('.proc-body [data-comment-item]', all('.main .tr .turn').at(-3)),
  )
  one<HTMLButtonElement>('.ucmt-btn', directTurn)?.click()
  const cardFlash = await until('卡片跳过去闪一下', () => flashed()[0]).catch(() => '')
  const card = {
    reopened: Boolean(one('.proc-body [data-comment-item]', all('.main .tr .turn').at(-3))),
    flashed: cardFlash,
  }

  // 十一、十条之后点不了
  const words = ['重试', '固定', '三次', '网络', '指数', '退避', '超时', '服务端', '重复', '下单']
  for (const word of words) {
    await selectWord(answer, word)
    const button = await until('“评论”', () =>
      one<HTMLButtonElement>('.cmt-pop [data-act="comment"]'),
    )
    if (button.disabled) break
    button.click()
    const input = await until('评论框', () => (document.activeElement === note() ? note() : null))
    press(input, 'Enter')
    await until('编辑框关上', () => !editor())
    await clearSelection()
  }
  await selectWord(answer, '建议')
  const full = Boolean(one<HTMLButtonElement>('.cmt-pop [data-act="comment"]')?.disabled)
  await clearSelection()
  // 只留一条，看重开之后还在不在
  while (chips().length > 1) {
    one<HTMLButtonElement>('.cmp-chip-x', chips().at(-1))?.click()
    await frame()
  }

  return {
    pop: popResult,
    refused: { user: userRefused, command: commandRefused },
    across,
    editor: { focused: Boolean(focusedField), quote: quoteOk, shiftKept, escDropped },
    added,
    chipEdit: { above, saved, located, badgeOpens },
    direct,
    sent,
    cites: citesResult,
    card,
    full,
  }
}

export interface CommentsReloaded {
  /** 重新加载之后片还在、原文上的记号还在；发出去的卡片还在 */
  chips: string[]
  badges: number
  cards: number
}

export async function commentsReloaded(session: string): Promise<CommentsReloaded> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
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
    throw new Error(`评论（重开之后）：等不到${what}`)
  }
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const row = await until(`侧栏里的“${session}”`, () =>
    all('.ss-row').find((entry) => text(entry).includes(session)),
  )
  row.click()
  await until('内容', () => all('.main .tr .ucmt').length > 0)
  await until('原文上的记号', () => all('.main .tr .cmt-badge').length > 0, 5_000).catch(() => null)
  const result = {
    chips: all('.dock .cmt-chip .cmp-chip-open').map((chip) => text(chip)),
    badges: all('.main .tr .cmt-badge').length,
    cards: all('.main .tr .ucmt').length,
  }
  for (const cross of all('.dock .cmt-chip .cmp-chip-x')) cross.click()
  return result
}

export function judgeComments(probe: CommentsProbe, reloaded: CommentsReloaded): string[] {
  const failed: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) failed.push(`评论：${what}`)
  }
  check(probe.pop.shown, '选中回答里的一段之后没有出浮层')
  check(probe.pop.above, '浮层不在选区上面')
  check(
    probe.pop.buttons.join() === 'comment,copy',
    `浮层上的按钮不对：${probe.pop.buttons.join()}`,
  )
  check(probe.refused.user, '选中用户消息也出了浮层')
  check(probe.refused.command, '选中命令输出也出了浮层')
  check(probe.across.shown, '从说明选到最终回答没有出浮层')
  check(probe.across.clipped, '跨了两条时选区没有缩到开头那条里')
  check(probe.editor.focused, '编辑框打开时焦点不在评论框里')
  check(probe.editor.quote, '编辑框里的引用不对')
  check(probe.editor.shiftKept, 'Shift+回车把评论加进去了')
  check(probe.editor.escDropped, 'Esc 之后还是加进去了')
  check(
    probe.added.chips.length === 2 &&
      /^1每次立刻重来为什么是三次？$/.test(probe.added.chips[0] ?? '') &&
      (probe.added.chips[1] ?? '').startsWith('2'),
    `加了两条之后的片不对：${probe.added.chips.join(' | ')}`,
  )
  check(
    probe.added.marked[0] === '每次立刻重来' && probe.added.marked[1] === 'const delay',
    `原文上的底色不对：${probe.added.marked.join(' | ')}`,
  )
  check(probe.added.badges.join() === '1,2', `原文上的记号不对：${probe.added.badges.join()}`)
  check(probe.chipEdit.above, '点片打开的编辑框不在片上面')
  check(probe.chipEdit.saved, '在片上改的评论没存上')
  check(probe.chipEdit.located, '“定位原文”没有让原文闪一下')
  check(probe.chipEdit.badgeOpens, '点原文上的记号没有打开编辑框')
  check(probe.direct.cards === 1, `⌘回车直接发的那条消息带了 ${probe.direct.cards} 张卡片`)
  check(probe.direct.textKept, '⌘回车直接发把输入框里的字动了')
  check(probe.direct.chipsKept === 2, `⌘回车直接发之后输入框上剩 ${probe.direct.chipsKept} 片`)
  check(
    probe.sent.cards.length === 2 && (probe.sent.cards[0] ?? '').includes('为什么固定三次？'),
    `发出去的卡片不对：${probe.sent.cards.join(' | ')}`,
  )
  check(probe.sent.rest === '还没写完的话', `卡片下面的字不对：${probe.sent.rest}`)
  check(probe.sent.cleared, '发出去之后片或者字还在')
  check(probe.sent.unmarked, '发出去之后原文上的底色或者记号还在')
  check(
    probe.cites.marks.join() === '评论 1,评论 2',
    `回答里的记号不对：${probe.cites.marks.join()}`,
  )
  check(probe.cites.literal, '超出条数的 [3] 没有照原文显示')
  check(probe.cites.peek, '悬停在记号上看不到引用')
  check(probe.cites.flashed === 'const delay', `点记号闪的不是原文：${probe.cites.flashed}`)
  check(probe.card.reopened, '点卡片没有替收起的过程打开')
  check(probe.card.flashed === '重试逻辑', `点卡片闪的不是原文：${probe.card.flashed}`)
  check(probe.full, '十条之后浮层上的“评论”还点得了')
  check(
    reloaded.chips.length === 1 && reloaded.chips[0]?.startsWith('1') === true,
    `重开之后的片不对：${reloaded.chips.join(' | ') || '没有'}`,
  )
  check(reloaded.badges === 1, `重开之后原文上的记号有 ${reloaded.badges} 个`)
  check(reloaded.cards >= 3, `重开之后对话里的评论卡片只有 ${reloaded.cards} 张`)
  return failed
}
