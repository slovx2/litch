// 侧栏验收：顶上“更多”里的“显示 Claude Code 子对话”。对着模拟核心：本机的 litch 里有一个
// Claude 桌面端从 s1 派出来的会话（示例数据里的 cd1），默认藏着，打开开关才画出来，挂在 s1 下面。
// 和别的验收一样，nativeSeen 会被原样送进页面里执行，不能引用函数外面的东西。
import type { SidebarKit } from './probe-sidebar-kit.mjs'

/** 示例数据里那个派出来的会话的标题 */
export const NATIVE_TITLE = '核对侧栏折叠规则（桌面端派出）'
/** 它在桌面端里的父会话 */
export const NATIVE_PARENT = 's1'

export interface NativeSeen {
  /** 一开始：本机下面有没有它；“更多”的按钮在不在 */
  shownAtStart: boolean
  entry: boolean
  /** 点开菜单：那一项在不在、勾没勾、焦点是不是落在菜单的头一项上 */
  option: boolean
  checkedAtStart: string | null
  focused: boolean
  /** 点一下：勾上了、菜单没收、它画出来了、记在界面本地的是 true */
  checked: string | null
  stayed: boolean
  shown: boolean
  /** 画出来时挂在哪个会话下面（外面一层的那一行），行上记的父会话 */
  under: string | null
  parentMark: string | null
  savedOn: boolean | null
  /** 按 Esc：菜单收起，焦点回到按钮上 */
  escaped: boolean
  /** 再打开点一下：不勾了、它又藏起来了、记着的是 false */
  shownAfter: boolean
  savedOff: boolean | null
}

export async function nativeSeen(title: string): Promise<NativeSeen> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, until, sleep, press } = kit
  const has = () => kit.titles('local').includes(title)
  const saved = () =>
    (JSON.parse(localStorage.getItem('litch.sidebar') ?? '{}') as { nativeChildren?: boolean })
      .nativeChildren ?? null
  const entry = () => one<HTMLButtonElement>('.sb-more > .ibtn')
  const option = () => one<HTMLButtonElement>('.sb-more [data-option="nativeChildren"]')
  await until('侧栏里的会话', () => kit.titles('local').length > 0, 10_000)
  const shownAtStart = has()
  const button = entry()
  button?.click()
  await until('更多的菜单', () => option(), 5000)
  const checkedAtStart = option()?.getAttribute('aria-checked') ?? null
  // 焦点落在菜单的头一项上（头一项是“永远显示活动对话”）
  const focused = document.activeElement === one('.sb-more [role="menu"] .pick-opt')
  option()?.click()
  await until('派出来的会话画出来', () => has(), 5000).catch(() => undefined)
  const checked = option()?.getAttribute('aria-checked') ?? null
  const stayed = option() !== null
  const shown = has()
  const line = kit.row(title)?.closest('.row-line') ?? null
  const outer = line?.closest('.tree-node')?.parentElement?.closest('.tree-node') ?? null
  const under = outer?.querySelector('.row-line')?.getAttribute('data-session') ?? null
  const parentMark = line?.getAttribute('data-parent') ?? null
  const savedOn = saved()
  press(option() ?? document.body, 'Escape')
  await sleep(100)
  const escaped = option() === null && document.activeElement === entry()
  entry()?.click()
  await until('更多的菜单', () => option(), 5000)
  option()?.click()
  await until('派出来的会话藏起来', () => !has(), 5000).catch(() => undefined)
  const shownAfter = has()
  const savedOff = saved()
  press(option() ?? document.body, 'Escape')
  await sleep(100)
  return {
    shownAtStart,
    entry: button !== null,
    option: checkedAtStart !== null,
    checkedAtStart,
    focused,
    checked,
    stayed,
    shown,
    under,
    parentMark,
    savedOn,
    escaped,
    shownAfter,
    savedOff,
  }
}

export function judgeNative(seen: NativeSeen, parent: string): string[] {
  const failed: string[] = []
  const must = (ok: boolean, message: string) => {
    if (!ok) failed.push(message)
  }
  must(seen.entry, '侧栏顶上没有“更多”')
  must(!seen.shownAtStart, '派出来的会话默认就画出来了')
  must(seen.option && seen.checkedAtStart === 'false', `“更多”里的开关不对：${seen.checkedAtStart}`)
  must(seen.focused, '点开“更多”焦点没落在头一项上')
  must(seen.checked === 'true' && seen.stayed, '点了开关没勾上，或者菜单收了')
  must(seen.shown, '打开开关后派出来的会话没画出来')
  must(
    seen.under === parent && seen.parentMark === parent,
    `派出来的会话没挂在父会话下面：在 ${seen.under} 下面，行上记的是 ${seen.parentMark}`,
  )
  must(seen.savedOn === true, `打开开关没记下来：${seen.savedOn}`)
  must(seen.escaped, '按 Esc 菜单没收起或焦点没回到按钮')
  must(!seen.shownAfter, '关上开关后派出来的会话还在')
  must(seen.savedOff === false, `关上开关没记下来：${seen.savedOff}`)
  return failed
}
