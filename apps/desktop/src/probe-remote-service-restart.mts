// 远程设备第二遍验收里的一段：侧栏设备行“⋯”里的“设置”和“重启设备服务”，对着真的设备服务
// （scripts/client-ssh-fixture.mjs 里装了适配器的那台：真的命令行经 ssh 跑 device-stop，客户端重连时 device-start 拉起来）。
//   一、“设置”进这台设备的详情，记下在跑的服务的进程号；
//   二、没有会话在跑：直接重启（空闲时停），行上写“重启中”，做完出提示，连回来的是另一个进程；
//   三、回合进行中：先列出这个会话确认，确认之后不等空闲直接停；做完的提示说打断了一个会话，
//       那个会话末尾说一句“发消息继续”，再发一句回合照常跑完，那一句去掉。
// 接在 serviceSession 后面（那台设备连着、有一个会话），编排在 smoke.mts。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
import type { TerminalKit } from './probe-terminal-kit.mjs'

export interface ServiceRestart {
  /** “设置”打开的是这台设备的详情 */
  settingsOpened: boolean
  /** 重启前后在跑的服务的进程号 */
  pidBefore: string
  pidIdle: string
  pidForced: string
  /** 空闲时重启：行上写过“重启中”、做完的提示 */
  idlePill: boolean
  idleToast: string
  /** 回合进行中：确认框列出的会话、做完的提示、会话末尾那一句 */
  confirm: string
  forcedToast: string
  note: string
  /** 再发一句：回话到了，那一句去掉了 */
  continued: boolean
  noteGone: boolean
}

export async function serviceRestart(svc: string, opening: string): Promise<ServiceRestart> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, all, text, frame } = kit
  const group = () =>
    all('.dev-group').find((element) => text(one('.dev-row .name', element)) === svc) as
      | HTMLElement
      | undefined
  const online = () => {
    const element = group()
    return Boolean(element && !element.classList.contains('off'))
  }
  const pill = () => text(one('.dev-row .pill', group() as HTMLElement))
  const toast = () => one('.toast[data-toast^="restart:"]')
  /** 点开这台设备的“⋯”，点其中一项 */
  const pick = async (action: string) => {
    ;(
      await until('设备行的“更多”', () =>
        one<HTMLButtonElement>(':scope > .row-line > .row-more > .ibtn', group() as HTMLElement),
      )
    ).click()
    ;(
      await until(`菜单里的 ${action}`, () =>
        one<HTMLButtonElement>(
          `.row-more .pick-opt[data-action="${action}"]`,
          group() as HTMLElement,
        ),
      )
    ).click()
  }
  /** 从“设置”进详情，读在跑的服务的进程号，再回到对话 */
  const pidNow = async () => {
    await pick('settings')
    const page = await until('这台设备的详情', () => one('[data-detail]'), 10_000)
    const section = await until('“设备服务”一节', () => one('[data-sec="service"]', page), 30_000)
    const fold = one<HTMLButtonElement>('.fold[aria-expanded="false"]', section)
    fold?.click()
    const pid = text(await until('进程号', () => one('[data-fact="pid"]', section), 10_000))
    one<HTMLButtonElement>('[data-act="back"]', page)?.click()
    await until('回到设备列表', () => !one('[data-detail]') && one('.devp-list'))
    one<HTMLButtonElement>('.devp .arch-head .ibtn')?.click()
    await until('设备页关上', () => !one('.devp'))
    return pid
  }
  const write = (target: HTMLTextAreaElement, words: string) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      target,
      words,
    )
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const say = async (words: string) => {
    const input = await until('输入框', () => one<HTMLTextAreaElement>('textarea.cmp-text'))
    write(input, words)
    await frame()
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
  }
  const lastTurn = () => text(all('.turn').at(-1))
  const running = () => Boolean(one('.running-line:not([data-hidden])') || one('.md.live'))
  const openSession = async () => {
    const row = all('.ss-row', group() as HTMLElement).find((entry) =>
      text(entry).includes(opening),
    )
    row?.click()
    await until('打开那个会话', () => text(one('.ss-row.sel')).includes(opening), 10_000)
  }

  // ---- 一、“设置”进详情，记下进程号 ----
  const pidBefore = await pidNow()
  const settingsOpened = pidBefore !== ''

  // ---- 二、没有会话在跑：直接重启 ----
  await openSession()
  await until('那个会话闲着', () => !running(), 60_000)
  await pick('restart')
  let idlePill = false
  const idle = await until(
    '重启做完的提示',
    () => {
      if (pill() === '重启中') idlePill = true
      return toast()
    },
    120_000,
  )
  const idleToast = text(one('.toast-text', idle))
  one<HTMLButtonElement>('.toast-x', idle)?.click()
  await until('连回来', online, 60_000)
  const pidIdle = await pidNow()

  // ---- 三、回合进行中：确认之后直接停，打断这个会话 ----
  await openSession()
  const during = '重启设备服务时在说的这一句'
  await say(during)
  await until('回话开始输出', () => (one('.md.live')?.textContent?.length ?? 0) > 0, 60_000)
  await pick('restart')
  const asked = await until(
    '列出会话的确认框',
    () => one('dialog.confirm [data-restart="sessions"]')?.closest('dialog') ?? null,
    30_000,
  )
  const confirm = [
    text(one('b', asked)),
    all('[data-restart="sessions"] li', asked).map(text).join('；'),
  ].join('｜')
  one<HTMLButtonElement>('.confirm-yes', asked)?.click()
  const forced = await until('重启做完的提示', toast, 120_000)
  const forcedToast = text(one('.toast-text', forced))
  one<HTMLButtonElement>('.toast-x', forced)?.click()
  await until('连回来', online, 60_000)
  const note = text(await until('末尾那一句', () => one('[data-restart-note]'), 60_000))

  // ---- 四、再发一句：回合照常跑完，那一句去掉 ----
  const after = '重启之后接着说的一句'
  await say(after)
  await until('重启之后的回话', () => lastTurn().includes(`收到：${after}`) && !running(), 120_000)
  const continued = true
  const noteGone = !one('[data-restart-note]')
  const pidForced = await pidNow()

  return {
    settingsOpened,
    pidBefore,
    pidIdle,
    pidForced,
    idlePill,
    idleToast,
    confirm,
    forcedToast,
    note,
    continued,
    noteGone,
  }
}

export function judgeServiceRestart(seen: ServiceRestart, svc: string, opening: string): string[] {
  const failed: string[] = []
  const must = (ok: boolean, message: string) => {
    if (!ok) failed.push(message)
  }
  must(seen.settingsOpened, '设备行菜单里的“设置”没有打开这台设备的详情（读不到进程号）')
  must(
    seen.pidIdle !== seen.pidBefore && seen.pidForced !== seen.pidIdle,
    `重启之后在跑的应该是另一个进程：${seen.pidBefore} → ${seen.pidIdle} → ${seen.pidForced}`,
  )
  must(seen.idlePill, '重启时设备行上没写过“重启中”')
  must(seen.idleToast === `已重启 ${svc} 的设备服务`, `空闲时重启的提示不对：${seen.idleToast}`)
  must(
    seen.confirm.startsWith(`重启 ${svc} 的设备服务？｜`) &&
      seen.confirm.includes(`${opening} · 回合进行中`),
    `回合进行中的确认框不对：${seen.confirm}`,
  )
  must(
    seen.forcedToast === `已重启 ${svc} 的设备服务，1 个会话被打断`,
    `打断回合之后的提示不对：${seen.forcedToast}`,
  )
  must(
    seen.note === '设备服务已重启，回合被打断。发送消息即可继续。',
    `被打断的会话末尾那一句不对：${seen.note}`,
  )
  must(seen.continued && seen.noteGone, '再发一句之后“发消息继续”那一句还在')
  return failed
}
