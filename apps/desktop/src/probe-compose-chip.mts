// 输入框里 @ 一个会话画成片的验收（只对着模拟核心）：选中后是片、光标进不去、退格整片删、撤销回来、
// 复制带上会话、切走再回来还在、发出去对话里是片、编辑已发消息时还是片；重新加载页面后草稿里的片还在（chipReloaded）。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。

export interface ChipProbe {
  /** 选中之后：输入框里的字、片的个数和上面的字、读屏说明 */
  picked: { text: string; chips: string[]; described: string; layered: boolean }
  /** 垫着的那层和输入框排版一致：宽度、字号、行高 */
  aligned: boolean
  /** 把光标放进片里：挪到了哪（片从 start 到 end） */
  caret: { at: number; start: number; end: number }
  /** 紧挨在片后面按退格：剩下的字和片数；撤销之后的字和片数 */
  backspace: { text: string; chips: number }
  undo: { text: string; chips: number }
  /** 复制整段：剪贴板里的文字、带上的会话 */
  copied: { plain: string; sessions: string }
  /** 切到别的会话再回来：片还在 */
  restored: number
  /** 发出去：对话里那条消息上的片；编辑它时编辑框里的片 */
  sent: string[]
  editing: number
}

export const CHIP_SESSION = '读一遍 launchd 的日志轮转'
export const CHIP_TARGET = 'Pi 入口过早上报最终回答'

export async function chipProbe(home: string, target: string): Promise<ChipProbe> {
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
    throw new Error(`会话片：等不到${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => one<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const chips = () => all('.dock .men-chip')
  const press = (field: EventTarget, key: string) =>
    field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  const idle = () =>
    until('这一轮结束', () => !one('.running-line') && !one('.req') && area(), 90_000)
  const open = async (title: string) => {
    const row = await until(`侧栏里的“${title}”`, () =>
      all('.ss-row:not(.projection-group *)').find((entry) => text(entry).includes(title)),
    )
    row.click()
    await until(`“${title}”的内容`, () => text(one('.crumb')).includes(title) && area())
    await frame()
    await idle()
    const field = await until('输入框', area)
    field.focus()
    await frame()
    return field
  }
  /** 走输入框自己的编辑：撤销栈里有它 */
  const type = (field: HTMLTextAreaElement, words: string) => {
    field.focus()
    document.execCommand('insertText', false, words)
  }
  const place = async (field: HTMLTextAreaElement, start: number, end = start) => {
    field.setSelectionRange(start, end)
    await frame()
    await sleep(50)
  }

  // ---- 一、打 @ 选中一个会话 ----
  let field = await open(home)
  field.select()
  document.execCommand('delete')
  type(field, '参考 @Pi')
  const option = () =>
    all('.dock .sug-opt[data-kind="session"]').find((entry) => text(entry).includes(target))
  await until(`单子里的“${target}”`, option, 15_000)
  for (let step = 0; step < 20; step++) {
    if (option()?.getAttribute('aria-selected') === 'true') break
    press(field, 'ArrowDown')
    await frame()
  }
  press(field, 'Enter')
  await until('输入框里的片', () => chips().length === 1)
  const describedBy = field.getAttribute('aria-describedby')
  const picked = {
    text: field.value,
    // 片上看得见的是标题：@[ 和 ] 是透明的占位
    chips: chips().map((chip) => text(chip).replace(/^@\[|\]$/g, '')),
    described: describedBy ? text(document.getElementById(describedBy)) : '',
    layered: field.classList.contains('men-on'),
  }
  const mirror = one('.dock .men-mirror')
  const look = getComputedStyle(field)
  const aligned =
    mirror !== null &&
    Math.abs(mirror.getBoundingClientRect().width - field.clientWidth) < 1 &&
    getComputedStyle(mirror).fontSize === look.fontSize &&
    getComputedStyle(mirror).lineHeight === look.lineHeight

  // ---- 二、光标进不去，退格整片删，撤销回来 ----
  type(field, '的结论')
  const start = field.value.indexOf('@[')
  const end = field.value.indexOf(']', start) + 1
  await place(field, start + 3)
  const caret = { at: field.selectionStart, start, end }
  await place(field, end)
  press(field, 'Backspace')
  await frame()
  const backspace = { text: field.value, chips: chips().length }
  document.execCommand('undo')
  await until('撤销后片回来', () => chips().length === 1, 5_000).catch(() => null)
  const undo = { text: field.value, chips: chips().length }

  // ---- 三、复制带上会话 ----
  field.select()
  const data = new DataTransfer()
  field.dispatchEvent(
    new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
  )
  const copied = {
    plain: data.getData('text/plain'),
    sessions: data.getData('application/x-litch-session-mentions'),
  }

  // ---- 四、切走再回来 ----
  const other = all('.ss-row:not(.projection-group *)').find(
    (entry) => !text(entry).includes(home) && !text(entry).includes(target),
  )
  other?.click()
  await until('切到别的会话', () => !text(one('.crumb')).includes(home))
  await frame()
  const row = await until(`侧栏里的“${home}”`, () =>
    all('.ss-row:not(.projection-group *)').find((entry) => text(entry).includes(home)),
  )
  row.click()
  await until('切回来', () => text(one('.crumb')).includes(home) && area())
  await frame()
  const restored = chips().length

  // ---- 五、发出去、编辑 ----
  field = area() as HTMLTextAreaElement
  field.focus()
  press(field, 'Enter')
  const last = await until('对话里那条消息', () => {
    const turn = all('.turn').at(-1)
    return turn && all('.umsg .smen', turn).length > 0 ? turn : null
  })
  const sent = all('.umsg .smen', last).map(text)
  await idle()
  const edit = all('button[aria-label="编辑消息"]', all('.turn').at(-1) ?? document).at(-1)
  edit?.click()
  await until('编辑框', () => one('.main textarea.umsg-edit'), 5_000).catch(() => null)
  await frame()
  const editing = all('.umsg.editing .men-chip').length
  const box = one('.main textarea.umsg-edit')
  if (box) press(box, 'Escape')
  await frame()
  return { picked, aligned, caret, backspace, undo, copied, restored, sent, editing }
}

/** 重新加载页面后：那个会话的草稿里还是片（提到的会话随正文存在本地存储里） */
export async function chipReloaded(home: string): Promise<number> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const end = performance.now() + 30_000
  while (performance.now() < end) {
    const row = [
      ...document.querySelectorAll<HTMLElement>('.ss-row:not(.projection-group *)'),
    ].find((entry) => text(entry).includes(home))
    if (row) {
      if (!text(document.querySelector('.crumb')).includes(home)) row.click()
      else if (document.querySelector('.dock .men-chip'))
        return document.querySelectorAll('.dock .men-chip').length
    }
    await sleep(50)
  }
  return 0
}

/** 草稿留着片的那一步：写一句带片的话不发，给重新加载之后看 */
export async function chipDraft(home: string, target: string): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const area = () => document.querySelector<HTMLTextAreaElement>('.dock textarea.cmp-text')
  const row = [...document.querySelectorAll<HTMLElement>('.ss-row:not(.projection-group *)')].find(
    (entry) => text(entry).includes(home),
  )
  row?.click()
  for (
    let step = 0;
    step < 200 && !(text(document.querySelector('.crumb')).includes(home) && area());
    step++
  )
    await sleep(20)
  const field = area()
  if (!field) return
  field.focus()
  document.execCommand('insertText', false, '留着 @Pi')
  for (let step = 0; step < 200; step++) {
    const option = [
      ...document.querySelectorAll<HTMLElement>('.dock .sug-opt[data-kind="session"]'),
    ].find((entry) => text(entry).includes(target))
    if (option?.getAttribute('aria-selected') === 'true') break
    if (option)
      field.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      )
    await sleep(30)
  }
  field.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  )
  for (let step = 0; step < 100 && !document.querySelector('.dock .men-chip'); step++)
    await sleep(20)
}

export function judgeChip(probe: ChipProbe, reloaded: number): string[] {
  const failed: string[] = []
  const check = (ok: boolean, what: string) => {
    if (!ok) failed.push(`会话片：${what}`)
  }
  const token = `@[${CHIP_TARGET}]`
  check(probe.picked.text === `参考 ${token} `, `选中后输入框里是“${probe.picked.text}”`)
  check(probe.picked.chips.join() === CHIP_TARGET, `片上的字不对：${probe.picked.chips.join('|')}`)
  check(probe.picked.described === `会话：${CHIP_TARGET}`, `读屏说明是“${probe.picked.described}”`)
  check(probe.picked.layered, '有片时输入框的字没有让给垫着的那层')
  check(probe.aligned, '垫着的那层和输入框的宽度或字号、行高对不上')
  check(
    probe.caret.at === probe.caret.start || probe.caret.at === probe.caret.end,
    `光标落进了片里（${probe.caret.at}，片是 ${probe.caret.start}–${probe.caret.end}）`,
  )
  check(
    probe.backspace.text === '参考  的结论' && probe.backspace.chips === 0,
    `退格后是“${probe.backspace.text}”、${probe.backspace.chips} 片`,
  )
  check(
    probe.undo.text === `参考 ${token} 的结论` && probe.undo.chips === 1,
    `撤销后是“${probe.undo.text}”、${probe.undo.chips} 片`,
  )
  check(probe.copied.plain === `参考 ${token} 的结论`, `复制的文字是“${probe.copied.plain}”`)
  check(
    probe.copied.sessions.includes(CHIP_TARGET),
    `复制时没有带上会话：“${probe.copied.sessions}”`,
  )
  check(probe.restored === 1, `切走再回来后有 ${probe.restored} 片`)
  check(probe.sent.join() === CHIP_TARGET, `发出去的消息上的片：${probe.sent.join('|') || '没有'}`)
  check(probe.editing === 1, `编辑已发消息时有 ${probe.editing} 片`)
  check(reloaded === 1, `重新加载后草稿里有 ${reloaded} 片`)
  return failed
}
