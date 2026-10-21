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
  /** 排队：提示、按钮；发出去进了托盘；托盘里点“现在就说”插进同一个回合 */
  queueHint: string
  queueButton: string
  queued: boolean
  manualSteered: boolean
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
  const said = (words: string) => all('.umsg-text').some((entry) => text(entry).includes(words))
  const inLastTurn = (words: string) => text(all('.turn').at(-1)).includes(words)

  const title = '发版前的检查清单'
  const open = async () => {
    const row = await until(`侧栏里的“${title}”`, () =>
      all('.ss-row').find((entry) => text(entry).includes(title)),
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
    await open()
    return choices
  }

  // ---- 一、立即发送：插进同一个回合，不进托盘 ----
  const choices = await pick('now')
  await idle()
  enter(await write('跑一会儿：先开个头'))
  await until('回合开始', running)
  const turns = all('.turn').length
  const steerInput = await write('直接插进去的话')
  const steerHint = steerInput.placeholder
  const steerButton = one('.dock .send')?.getAttribute('title') ?? ''
  enter(steerInput)
  let trayed = false
  await until('插进去的话出现在对话里', () => {
    trayed ||= Boolean(one('.tray-row'))
    return said('直接插进去的话')
  })
  await frame()
  trayed ||= Boolean(one('.tray-row'))
  const steered = !trayed && all('.turn').length === turns && inLastTurn('直接插进去的话')
  await idle()

  // ---- 二、排队：进托盘，点“现在就说”照样插进去 ----
  await pick('queue')
  await idle()
  enter(await write('跑一会儿：再开个头'))
  await until('回合开始', running)
  const before = all('.turn').length
  const queueInput = await write('排着的话')
  const queueHint = queueInput.placeholder
  const queueButton = one('.dock .send')?.getAttribute('title') ?? ''
  enter(queueInput)
  const queued = Boolean(
    await until('托盘里的那一条', () => one('.tray-row'), 5000).catch(() => null),
  )
  const steer = all('.tray-row .mini').find((button) => text(button).includes('现在就说'))
  steer?.click()
  const manualSteered = Boolean(
    await until(
      '点“现在就说”之后插进同一个回合',
      () => !one('.tray-row') && said('排着的话') && all('.turn').length === before,
      10_000,
    ).catch(() => null),
  )
  await idle()
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
    queueHint,
    queueButton,
    queued,
    manualSteered,
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
  check(probe.steerHint.includes('直接插进'), `立即发送时的提示不对：“${probe.steerHint}”`)
  check(probe.steerButton === '发送', `立即发送时按钮上写的是“${probe.steerButton}”`)
  check(
    probe.steered,
    '立即发送：回合进行中发的消息没有直接插进同一个回合（进了托盘或者另起了回合）',
  )
  check(probe.queueHint.includes('排队'), `排队时的提示不对：“${probe.queueHint}”`)
  check(probe.queueButton === '排队', `排队时按钮上写的是“${probe.queueButton}”`)
  check(probe.queued, '排队：回合进行中发的消息没有进托盘')
  check(probe.manualSteered, '排队：托盘里点“现在就说”没有插进同一个回合')
  check(probe.saved === '{"mode":"queue"}', `本机记下来的不对：${probe.saved}`)
  return failed
}
