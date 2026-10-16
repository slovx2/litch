// 侧栏验收：侧栏这个框本身。拖右边沿调宽度、用方向键调、窗口宽窄不同的时候它画多宽、
// 收起和展开（快捷键、标题栏的开关、应用菜单）、收着的时候怎么新建对话、应用重开之后还记得宽度和开合。
// 几段小的，主进程在它们之间改窗口大小、点应用菜单、重启核心，编排在 probe-sidebar-run.mts。
// 和别的验收一样，这里的函数会被原样送进页面里执行，不能引用函数外面的东西。
import type { SidebarKit } from './probe-sidebar-kit.mjs'

export interface FrameSeen {
  /** 窗口里面多宽；侧栏、右边那一块、对话区、侧面板各多宽（没显示的是 0） */
  inner: number
  sidebar: number
  body: number
  main: number
  side: number
  /** 侧面板现在是哪种摆法：docked 是窗口够宽，tight 是两边都让了 */
  sideMode: string
  open: boolean
  /** 标题栏的开关按没按着；旁边有没有“新对话” */
  pressed: string
  newShown: boolean
  /** 拖动条报给读屏的：现在多宽/最窄/最宽。没有拖动条是空的 */
  grip: string
  /** 记在界面本地的那一份 */
  saved: string
  /** 有没有东西伸到窗口右边外面去 */
  overflow: number
}

/** 侧栏现在怎么放的。inner：等窗口里面成了这么宽再量（主进程刚改了窗口大小） */
export async function frameSeen(inner?: number): Promise<FrameSeen> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, frame } = kit
  if (inner !== undefined) await kit.seen(() => window.innerWidth === inner, 5000)
  for (let count = 0; count < 4; count++) await frame()
  const width = (selector: string) => {
    const element = one(selector)
    return element && element.getClientRects().length > 0 ? element.offsetWidth : 0
  }
  const grip = one('.sb-grip')
  const right = Math.max(
    ...['.sb', '.body', '.main', '.side'].map(
      (selector) => one(selector)?.getBoundingClientRect().right ?? 0,
    ),
  )
  return {
    inner: window.innerWidth,
    sidebar: width('.sb'),
    body: width('.body'),
    main: width('.main'),
    side: width('.side'),
    sideMode: width('.side') > 0 ? (one('.side')?.dataset.mode ?? '') : '',
    open: width('.sb') > 0,
    pressed: one('.tb-sidebar')?.getAttribute('aria-pressed') ?? '',
    newShown: Boolean(one('.tb-new')),
    grip: grip
      ? ['aria-valuenow', 'aria-valuemin', 'aria-valuemax']
          .map((name) => grip.getAttribute(name))
          .join('/')
      : '',
    saved: localStorage.getItem('litch.sidebar') ?? '',
    overflow: Math.max(0, Math.round(right - window.innerWidth)),
  }
}

/** 按住拖动条横着挪，把侧栏拖到 target 这么宽（到不了就停在能到的地方）。返回拖完之后多宽 */
export async function dragTo(target: number): Promise<number> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, frame } = kit
  const panel = one('.sb') as HTMLElement
  const handle = one('.sb-grip') as HTMLElement
  const box = handle.getBoundingClientRect()
  const x = box.left + box.width / 2
  const by = target - panel.offsetWidth
  // 鼠标的指针编号是 1
  const at = (clientX: number): PointerEventInit => ({
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX,
    clientY: box.top + box.height / 2,
    bubbles: true,
    cancelable: true,
  })
  handle.dispatchEvent(new PointerEvent('pointerdown', at(x)))
  for (const share of [0.25, 0.5, 0.75, 1]) {
    handle.dispatchEvent(new PointerEvent('pointermove', at(x + by * share)))
    await frame()
  }
  handle.dispatchEvent(new PointerEvent('pointerup', at(x + by)))
  await frame()
  await frame()
  return panel.offsetWidth
}

export interface KeysSeen {
  /** 焦点在拖动条上，按右、右、左：一开始和每按一下之后各多宽 */
  widths: number[]
  /** 拖动条是不是键盘走得到的分隔条 */
  role: string
  /** 调宽度的时候，侧栏里的会话行是不是原来那些元素（没有因为拖动整个重画） */
  rowsKept: boolean
}

export async function keysSeen(): Promise<KeysSeen> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, all, frame } = kit
  const panel = one('.sb') as HTMLElement
  const handle = one('.sb-grip') as HTMLElement
  const rows = all('.ss-row')
  handle.focus()
  const widths = [panel.offsetWidth]
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft']) {
    kit.press(handle, key)
    await frame()
    await frame()
    widths.push(panel.offsetWidth)
  }
  const after = all('.ss-row')
  return {
    widths,
    role: `${handle.getAttribute('role')}/${handle.getAttribute('aria-orientation')}/${handle.tabIndex}`,
    rowsKept: rows.length > 0 && rows.every((row, index) => row === after[index]),
  }
}

/** 等侧栏成了开着（或者收着）的样子，返回等到了没有。主进程点了应用菜单之后用 */
export async function sidebarBecame(open: boolean): Promise<boolean> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const shown = () => (kit.one('.sb')?.getClientRects().length ?? 0) > 0
  const ok = await kit.seen(() => shown() === open, 5000)
  // 开合有一小段防重的时间：下一次开合之前让它过去
  await kit.sleep(220)
  return ok
}

/** 把右边的侧面板打开或者收起，等它变过去 */
export async function sidePanel(open: boolean): Promise<void> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one } = kit
  const shown = () => (one('.side')?.getClientRects().length ?? 0) > 0
  if (shown() !== open) {
    await kit.sleep(220)
    one<HTMLButtonElement>('.tb-side')?.click()
  }
  await kit.until(open ? '侧面板打开' : '侧面板收起', () => shown() === open, 10_000)
  await kit.sleep(220)
}
