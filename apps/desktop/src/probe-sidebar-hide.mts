// 侧栏验收：收起和展开。快捷键、标题栏的开关；收着的时候新建对话还有路可走；
// 展开回来里面还是原样；应用重开之后记得。
// 和别的验收一样，这里的函数会被原样送进页面里执行，不能引用函数外面的东西。
import type { SidebarKit } from './probe-sidebar-kit.mjs'

export interface HideSeen {
  /** 按 Cmd/Ctrl+Shift+B：收起 */
  closedByKey: boolean
  /** 这时右边那一块占满窗口，拖动条没了 */
  filled: boolean
  gripGone: boolean
  /** 标题栏：开关没按着，旁边多出“新对话” */
  pressed: string
  newShown: boolean
  /**
   * 标题栏最左边的东西离窗口左边多远。桌面外壳里系统的窗口按钮盖在左上角，要给它让出位置；
   * 侧栏开着、收着各量一次，应该一样
   */
  leftOpen: number
  leftClosed: number
  shell: string
  /** 根元素上写的系统：mac、win、linux */
  platform: string
  /** 收着的时候按 Cmd/Ctrl+N：到了新建对话页 */
  newByKey: boolean
  /** 焦点在输入框里再按一次快捷键：展开 */
  openedFromComposer: boolean
  /** 展开之后宽度还是原来的；之前收起的那个项目还收着（收起侧栏只是不显示） */
  widthBefore: number
  widthBack: number
  foldKept: boolean
  /** 点标题栏的开关：收起；这时点标题栏的“新对话”到了新建对话页；再点开关：展开，“新对话”收掉 */
  closedByButton: boolean
  newByButton: boolean
  openedByButton: boolean
  /** 记在界面本地的那一份里，收着的时候写的是什么 */
  savedClosed: string
}

export async function hideSeen(session: string): Promise<HideSeen> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one, sleep } = kit
  const shown = () => (one('.sb')?.getClientRects().length ?? 0) > 0
  const chord = (target: EventTarget) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'B',
        code: 'KeyB',
        shiftKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  const toggle = () => one<HTMLButtonElement>('.tb-sidebar') as HTMLButtonElement
  const first = () => Math.round((one('.tb > *') as HTMLElement).getBoundingClientRect().left)
  const onNewPage = () => Boolean(one('.new-hero'))

  // 留一个记号：收起一个项目，等会儿看侧栏展开回来它还收着没有
  const backup = () => kit.workspaceLine('nas', 'backup-scripts')
  await kit.fold(backup(), false)
  await kit.open(session)
  const widthBefore = (one('.sb') as HTMLElement).offsetWidth
  const leftOpen = first()

  // ---- 一、快捷键收起 ----
  await sleep(220)
  chord(document.body)
  const closedByKey = await kit.seen(() => !shown(), 3000)
  await sleep(220)
  const filled = (one('.body') as HTMLElement).offsetWidth === window.innerWidth
  const gripGone = !one('.sb-grip')
  const pressed = toggle().getAttribute('aria-pressed') ?? ''
  const newShown = Boolean(one('.tb-new'))
  const leftClosed = first()
  const savedClosed = localStorage.getItem('litch.sidebar') ?? ''

  // ---- 二、收着的时候新建：Cmd/Ctrl+N ----
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', metaKey: true, bubbles: true }),
  )
  const newByKey = await kit.seen(onNewPage, 5000)

  // ---- 三、焦点在输入框里按快捷键：展开，里面还是原样 ----
  const area = await kit.until('新建对话页的输入框', () =>
    one<HTMLTextAreaElement>('textarea.cmp-text'),
  )
  area.focus()
  chord(area)
  const openedFromComposer = await kit.seen(shown, 3000)
  await sleep(220)
  const widthBack = (one('.sb') as HTMLElement).offsetWidth
  const foldKept = !kit.expanded(backup())
  await kit.fold(backup(), true)

  // ---- 四、标题栏的开关；收着的时候点标题栏的“新对话” ----
  await kit.open(session)
  toggle().click()
  const closedByButton = await kit.seen(() => !shown(), 3000)
  await sleep(220)
  one<HTMLButtonElement>('.tb-new')?.click()
  const newByButton = await kit.seen(onNewPage, 5000)
  toggle().click()
  const openedByButton = (await kit.seen(shown, 3000)) && !one('.tb-new')
  await sleep(220)

  return {
    closedByKey,
    filled,
    gripGone,
    pressed,
    newShown,
    leftOpen,
    leftClosed,
    shell: document.documentElement.dataset.shell ?? '',
    platform: document.documentElement.dataset.platform ?? '',
    newByKey,
    openedFromComposer,
    widthBefore,
    widthBack,
    foldKept,
    closedByButton,
    newByButton,
    openedByButton,
    savedClosed,
  }
}

/** 把侧栏收起来（点标题栏的开关），等它收好。重开应用之前用 */
export async function hideNow(): Promise<void> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const shown = () => (kit.one('.sb')?.getClientRects().length ?? 0) > 0
  await kit.sleep(220)
  if (shown()) kit.one<HTMLButtonElement>('.tb-sidebar')?.click()
  await kit.until('侧栏收起', () => !shown(), 5000)
}

export interface ReloadSeen {
  /** 重新加载之后：侧栏还是收着的，标题栏上有“新对话” */
  closedAtStart: boolean
  newShown: boolean
  /** 点开关展开：宽度还是重开之前拖出来的那个 */
  width: number
}

/** 页面重新加载之后（核心重启）。要先重新装一次工具 */
export async function reloadSeen(): Promise<ReloadSeen> {
  const kit = (window as unknown as { __sidebarKit: SidebarKit }).__sidebarKit
  const { one } = kit
  const shown = () => (one('.sb')?.getClientRects().length ?? 0) > 0
  // 侧栏收着，里面的行照样在（只是不显示）：等数据到了再看
  await kit.until('侧栏里有会话', () => one('.ss-row'), 40_000)
  const closedAtStart = !shown()
  const newShown = Boolean(one('.tb-new'))
  one<HTMLButtonElement>('.tb-sidebar')?.click()
  await kit.until('侧栏展开', shown, 5000)
  await kit.frame()
  return { closedAtStart, newShown, width: (one('.sb') as HTMLElement).offsetWidth }
}
