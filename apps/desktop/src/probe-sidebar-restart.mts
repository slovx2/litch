// 侧栏验收：设备那一行“⋯”里的“设置”和“重启设备服务”。对着模拟核心（packages/core/src/mock/mock-restart.mts）：
// 各台设备的菜单里有这两项，做不了的那一项淡下去、写原因；“设置”进这台设备的详情；
// 本机有会话在跑时先列出来确认，确认之后行上写“重启中”、做完出提示，被打断的会话末尾说一句“发消息继续”，
// 再说一句就没了；服务说不闲时列出原因再问；停了没能连回来时提示原因、带“重试”。
// 和别的验收一样，restartSeen 会被原样送进页面里执行，不能引用函数外面的东西；judgeRestart 在主进程里跑。
import type { SidebarKit } from './probe-sidebar-kit.mjs'

/** 示例数据里本机上停着等人的会话：先打开它，重启时它的回合被打断 */
export const RESTART_SESSION = '聚合面：会话列表合并与复合游标'

export interface RestartSeen {
  /** 各台设备菜单里的项：local / build / nas / gpu，“字（淡下去的带原因）”用 | 隔开 */
  menus: Record<string, string>
  /** 点“设置”：进了哪台设备的详情 */
  settingsAt: string
  /** 本机有会话在跑：确认框的标题｜列出来的会话 */
  confirm: string
  /** 点“取消”：确认框收起，没有重启 */
  cancelled: boolean
  /** 确认之后：设备行上的小标｜菜单里那一项的字:点不点得了 */
  during: string
  doneToast: string
  /** 被打断的会话末尾那一句；再说一句之后还在不在 */
  note: string
  noteAfter: boolean
  /** 服务说不闲：确认框的标题｜逐条原因；点“取消”之后确认框收起 */
  busy: string
  busyClosed: boolean
  /** 停了没能连回来：提示的字｜有没有“重试”；设备行下面点“重试”之后连回来了没有 */
  failToast: string
  backOnline: boolean
  /** 英文界面里本机菜单的最后两项 */
  english: string
}

export async function restartSeen(title: string): Promise<RestartSeen> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, all, until, sleep, text, press } = kit
  const appearance = (
    window as unknown as {
      __litchLook: { get(): { lang: string }; set(patch: { lang?: string }): void }
    }
  ).__litchLook
  const line = (id: string) => kit.deviceLine(id)
  /** 打开一台设备的菜单，交给 use 看或者点，最后收起 */
  const withMenu = async <T,>(id: string, use: (pop: HTMLElement) => T | Promise<T>) => {
    one<HTMLButtonElement>('.row-more > .ibtn', line(id))?.click()
    const pop = await until(
      `${id} 的菜单`,
      () => one<HTMLElement>('.row-more .pick-pop', line(id)),
      5000,
    )
    const result = await use(pop)
    if (pop.isConnected) {
      press(document.activeElement ?? pop, 'Escape')
      await until('菜单收起', () => !pop.isConnected, 5000)
    }
    return result
  }
  const items = (pop: HTMLElement) =>
    all('.pick-opt', pop)
      .map((entry) => {
        const note = one('span', entry)
        return `${text(one('b', entry))}${note ? `（${text(note)}）` : ''}`
      })
      .join('|')
  const pick = (pop: HTMLElement, action: string) =>
    one<HTMLButtonElement>(`.pick-opt[data-action="${action}"]`, pop)?.click()
  const pill = () => text(one('.dev-row .pill', line('local')))
  const toast = () => text(one('[data-toast="restart:local"] .toast-text'))
  const dialog = () => one('dialog.confirm')
  /** 说了一句之后：等回合开始，再等它结束（回复是过一会儿才来的，光看“没在跑”会抢在它前面） */
  const settled = async () => {
    await kit.seen(() => one('.running-line'), 3000)
    await until('回合结束', () => !one('.running-line') && !one('.req'), 20_000)
    await sleep(300)
  }

  // ---- 一、各台设备的菜单 ----
  const menus: Record<string, string> = {}
  for (const id of ['local', 'build', 'nas', 'gpu']) menus[id] = await withMenu(id, items)

  // ---- 二、“设置”进这台设备的详情 ----
  await withMenu('build', (pop) => pick(pop, 'settings'))
  const settingsAt = await until(
    '设备详情',
    () => one<HTMLElement>('[data-detail]')?.dataset.detail,
  )

  // ---- 三、有会话在跑：先确认；取消了不重启 ----
  await kit.open(title)
  await withMenu('local', (pop) => pick(pop, 'restart'))
  const asked = await until('列出会话的确认框', dialog, 5000)
  const confirm = [
    text(one('b', asked)),
    all('[data-restart="sessions"] li', asked).map(text).join('；'),
  ].join('｜')
  one<HTMLButtonElement>('.btn.ghost', asked)?.click()
  await until('确认框收起', () => !dialog(), 5000)
  await sleep(300)
  const cancelled = pill() === '' && toast() === ''

  // ---- 四、确认了：重启中，做完出提示 ----
  await withMenu('local', (pop) => pick(pop, 'restart'))
  ;(
    await until('确认框', () => one<HTMLButtonElement>('dialog.confirm .confirm-yes'), 5000)
  ).click()
  await until('行上写“重启中”', () => pill() === '重启中', 5000)
  const during = [
    pill(),
    await withMenu('local', (pop) => {
      const entry = one('.pick-opt[data-action="restart"]', pop)
      return `${text(entry ? one('b', entry) : null)}:${entry?.getAttribute('aria-disabled') ?? '能点'}`
    }),
  ].join('｜')
  const doneToast = await until('做完的提示', () => toast(), 10_000)
  await until('行上的“重启中”去掉', () => pill() === '', 5000)

  // ---- 五、被打断的会话末尾那一句；再说一句就没了 ----
  const note = text(await until('末尾那一句', () => one('[data-restart-note]'), 5000))
  await kit.say('继续')
  const noteAfter = !(await kit.seen(() => !one('[data-restart-note]'), 5000))
  await settled()

  // ---- 六、服务说不闲：列出原因再问，取消 ----
  await kit.say('重启时忙')
  await settled()
  await withMenu('local', (pop) => pick(pop, 'restart'))
  const held = await until(
    '不闲的确认框',
    () => (one('dialog.confirm [data-restart="busy"]') ? dialog() : null),
    10_000,
  )
  const busy = [
    text(one('b', held)),
    all('[data-restart="busy"] li', held).map(text).join('；'),
  ].join('｜')
  one<HTMLButtonElement>('.btn.ghost', held)?.click()
  const busyClosed = await kit.seen(() => !dialog(), 5000)

  // ---- 七、停了没能连回来：提示原因，带“重试”；设备行下面点“重试”连回来 ----
  await kit.say('重启会失败')
  await settled()
  await withMenu('local', (pop) => pick(pop, 'restart'))
  const failed = await until(
    '没做成的提示',
    () => {
      const now = one('[data-toast="restart:local"]')
      return now?.classList.contains('err') ? now : null
    },
    10_000,
  )
  const failToast = [text(one('.toast-text', failed)), text(one('.toast-act', failed))].join('｜')
  one<HTMLButtonElement>('.toast-x', failed)?.click()
  ;(
    await until(
      '设备行下面的“重试”',
      () => one<HTMLButtonElement>('.dev-note .retry', kit.device('local')),
      5000,
    )
  ).click()
  const backOnline = await kit.seen(() => !one('.dev-note .cfail', kit.device('local')), 5000)

  // ---- 八、英文 ----
  const was = appearance.get().lang
  appearance.set({ lang: 'en' })
  await sleep(200)
  const english = await withMenu('local', (pop) => items(pop).split('|').slice(-2).join('|'))
  appearance.set({ lang: was })
  await sleep(200)

  return {
    menus,
    settingsAt,
    confirm,
    cancelled,
    during,
    doneToast,
    note,
    noteAfter,
    busy,
    busyClosed,
    failToast,
    backOnline,
    english,
  }
}

export function judgeRestart(seen: RestartSeen, title: string): string[] {
  const failed: string[] = []
  const must = (ok: boolean, message: string) => {
    if (!ok) failed.push(message)
  }
  const tail = (menu: string | undefined) => (menu ?? '').split('|').slice(-2).join('|')
  must(
    tail(seen.menus.local) === '设置|重启设备服务',
    `本机菜单的最后两项不对：${seen.menus.local}`,
  )
  must(
    tail(seen.menus.build) ===
      '设置|重启设备服务（服务由前台或服务管理器启动，请用原来的方式重启）',
    `build-01 的服务是前台的，“重启设备服务”该淡下去、写原因：${seen.menus.build}`,
  )
  must(
    tail(seen.menus.nas) === '设置|重启设备服务（只连接了单个 harness，没有设备服务）',
    `nas 只连着一个 harness，“重启设备服务”该淡下去、写原因：${seen.menus.nas}`,
  )
  must(
    tail(seen.menus.gpu) === '设置|重启设备服务（设备未连接）',
    `gpu 没连上，“重启设备服务”该淡下去、写原因：${seen.menus.gpu}`,
  )
  must(seen.settingsAt === 'build', `“设置”该进 build 的详情：${seen.settingsAt}`)
  must(
    seen.confirm.startsWith('重启 本机 的设备服务？｜') &&
      seen.confirm.includes(`${title} · 回合进行中`),
    `有会话在跑时的确认框不对：${seen.confirm}`,
  )
  must(seen.cancelled, '确认框里点了“取消”，还是重启了')
  must(
    seen.during === '重启中｜正在重启…:true',
    `重启时行上该写“重启中”、菜单那一项点不了：${seen.during}`,
  )
  must(
    /^已重启 本机 的设备服务，\d+ 个会话被打断$/.test(seen.doneToast),
    `做完的提示不对：${seen.doneToast}`,
  )
  must(
    seen.note === '设备服务已重启，回合被打断。发送消息即可继续。',
    `被打断的会话末尾那一句不对：${seen.note}`,
  )
  must(!seen.noteAfter, '再说一句之后，“发消息继续”那一句还在')
  must(
    seen.busy === '本机 的设备服务正忙｜1 个终端正在运行',
    `服务说不闲时的确认框不对：${seen.busy}`,
  )
  must(seen.busyClosed, '不闲的确认框点了“取消”没有收起')
  must(
    seen.failToast.startsWith('本机 的设备服务未能重启：设备服务已停止，但未能重新连接') &&
      seen.failToast.endsWith('｜重试'),
    `没能连回来的提示不对：${seen.failToast}`,
  )
  must(seen.backOnline, '设备行下面点了“重试”，本机没有连回来')
  must(
    seen.english === 'Settings|Restart device service',
    `英文菜单的最后两项不对：${seen.english}`,
  )
  return failed
}
