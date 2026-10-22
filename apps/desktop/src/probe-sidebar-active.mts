// 侧栏验收：顶上“更多”里的“永远显示活动对话”。对着模拟核心：本机的 litch 里 s1（Claude Code）在跑，
// s3、docs-site 里的 s7（Pi）没看过，s2（Claude Code）在等审批。只看 DSH 的时候，开关开着这几个照样列出，关着只剩等人的。
// 开关默认开；前面的筛选验收量的是原来的筛法，开始前先用 activeSet 关上，量完这一段再打开。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
import type { SidebarKit } from './probe-sidebar-kit.mjs'

/** 在跑的、没看过的（别的 harness 的）、等人的那几个会话的标题 */
export const ACTIVE_TITLES = {
  running: '把运行时与 SSH 入口的启动拆开',
  unread: ['Pi 入口过早上报最终回答', '能力矩阵页改成从声明生成'],
  waiting: '聚合面：会话列表合并与复合游标',
  /** 只看 DSH 时本来就在的：DSH 自己的会话 */
  own: '设备进程的转发开销基准',
}

/** 把开关拨到 on（点开“更多”、点一下、收起） */
export async function activeSet(on: boolean): Promise<void> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const option = () => kit.one<HTMLButtonElement>('.sb-more [data-option="showActive"]')
  kit.one<HTMLButtonElement>('.sb-more > .ibtn')?.click()
  await kit.until('“更多”的菜单', () => option(), 5000)
  if ((option()?.getAttribute('aria-checked') === 'true') !== on) option()?.click()
  await kit.until('开关拨过去', () => option()?.getAttribute('aria-checked') === String(on), 5000)
  kit.press(option() ?? document.body, 'Escape')
  await kit.seen(() => !option(), 3000)
}

export interface ActiveSeen {
  /** 菜单里的开关：写的什么、开始时（前面关上了）勾没勾 */
  label: string
  checkedAtStart: string | null
  /** 只看 DSH、开关关着时本机下面的会话标题 */
  off: string[]
  /** 打开开关之后 */
  on: string[]
  /** 记在界面本地的 */
  saved: boolean | null
}

export async function activeSeen(): Promise<ActiveSeen> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, until, text } = kit
  const option = () => one<HTMLButtonElement>('.sb-more [data-option="showActive"]')
  const filterTo = async (harness: string | null) => {
    const now = () => one('.sb-filter-on')?.dataset.harness ?? null
    if (now() === harness) return
    ;(await until('筛选的入口', () => one<HTMLButtonElement>('.sb-filter > .ibtn'))).click()
    const pop = await until('筛选的选项', () => one('.sb-filter .pick-pop'), 5000)
    one<HTMLButtonElement>(`[data-harness="${harness ?? ''}"]`, pop)?.click()
    await until('筛选换过去', () => now() === harness, 5000)
    if (one('.sb-filter .pick-pop')) kit.press(document.activeElement ?? pop, 'Escape')
    await kit.seen(() => !one('.sb-filter .pick-pop'), 3000)
    await kit.frame()
  }
  await until('侧栏里的会话', () => kit.titles('local').length > 0, 10_000)
  one<HTMLButtonElement>('.sb-more > .ibtn')?.click()
  await until('“更多”的菜单', () => option(), 5000)
  const label = text(one('b', option() ?? undefined))
  const checkedAtStart = option()?.getAttribute('aria-checked') ?? null
  kit.press(option() ?? document.body, 'Escape')
  await kit.seen(() => !option(), 3000)

  await filterTo('dsh')
  const off = kit.titles('local')
  // 打开开关（和 activeSet 一样，这里不能调外面的函数）
  one<HTMLButtonElement>('.sb-more > .ibtn')?.click()
  await until('“更多”的菜单', () => option(), 5000)
  option()?.click()
  await until('开关打开', () => option()?.getAttribute('aria-checked') === 'true', 5000)
  kit.press(option() ?? document.body, 'Escape')
  await kit.seen(() => !option(), 3000)
  await kit.sleep(100)
  const on = kit.titles('local')
  const saved =
    (JSON.parse(localStorage.getItem('litch.sidebar') ?? '{}') as { showActive?: boolean })
      .showActive ?? null
  await filterTo(null)
  return { label, checkedAtStart, off, on, saved }
}

export function judgeActive(seen: ActiveSeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, message: string) => {
    if (!ok) failed.push(message)
  }
  const { running, unread, waiting, own } = ACTIVE_TITLES
  must(seen.label === '始终显示活动对话', `“更多”里的开关写的是：${seen.label}`)
  must(seen.checkedAtStart === 'false', `前面关上了的开关没跟着变：${seen.checkedAtStart}`)
  must(
    seen.off.includes(own) &&
      seen.off.includes(waiting) &&
      !seen.off.includes(running) &&
      unread.every((title) => !seen.off.includes(title)),
    `开关关着、只看 DSH 时不对（应该只有 DSH 的和等人的）：${seen.off.join('、')}`,
  )
  must(
    seen.on.includes(own) &&
      seen.on.includes(waiting) &&
      seen.on.includes(running) &&
      unread.every((title) => seen.on.includes(title)),
    `开关开着、只看 DSH 时别的 harness 在跑、没看过的没列出来：${seen.on.join('、')}`,
  )
  must(seen.saved === true, `打开开关没记下来：${seen.saved}`)
  return failed
}
