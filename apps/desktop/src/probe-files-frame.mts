// 文件面板的验收：侧面板这个框本身。窗口宽窄不同的时候它画多宽、键盘快捷键、用方向键调宽度、
// 标签栏上的收起按钮、应用重开之后还记得开合和宽度。几段小的，主进程在它们之间改窗口大小、点应用菜单、
// 重启核心，编排在 probe-files-run.mts。
import type { FilesKit } from './probe-files-kit.mjs'

export interface FrameSeen {
  open: boolean
  /** docked：窗口够宽；tight：窗口窄，两边都让了。哪种都是和对话并排 */
  mode: string
  /** 面板、对话区、侧栏各多宽，窗口里面多宽 */
  side: number
  main: number
  sidebar: number
  inner: number
  /** 面板的左边离对话区的右边多远：0 是紧挨着，负数是压到对话上了 */
  gap: number
  /** 文件标签是不是上下摆的（树在上、内容在下） */
  stacked: boolean
  /** 面板的右边有没有超出窗口 */
  overflow: number
  /** 记在界面本地的那一份 */
  saved: string
  pressed: string
}

/** 面板现在怎么放的。inner：等窗口里面成了这么宽再量（主进程刚改了窗口大小） */
export async function frameSeen(inner?: number): Promise<FrameSeen> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { one, frame } = kit
  if (inner !== undefined) await kit.seen(() => window.innerWidth === inner, 5000)
  for (let count = 0; count < 4; count++) await frame()
  const panel = kit.side()
  const main = one('.main')
  const box = panel?.getBoundingClientRect()
  const tree = one('.ft')?.getBoundingClientRect()
  const view = one('.fv')?.getBoundingClientRect()
  return {
    open: kit.sideOpen(),
    mode: panel?.dataset.mode ?? '',
    side: panel && !panel.hidden ? panel.offsetWidth : 0,
    main: main?.offsetWidth ?? 0,
    sidebar: one('.sb')?.offsetWidth ?? 0,
    inner: window.innerWidth,
    gap: box && main ? Math.round(box.left - main.getBoundingClientRect().right) : 0,
    stacked: Boolean(tree && view && tree.bottom <= view.top + 1),
    overflow: box ? Math.max(0, Math.round(box.right - window.innerWidth)) : 0,
    saved: localStorage.getItem('litch.side') ?? '',
    pressed: one('.tb-side')?.getAttribute('aria-pressed') ?? '',
  }
}

/** 等面板成了开着（或者收着）的样子，返回等到了没有。主进程点了应用菜单之后用 */
export async function sideBecame(open: boolean): Promise<boolean> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const ok = await kit.seen(() => kit.sideOpen() === open, 5000)
  // 开合有一小段防重的时间：下一次开合之前让它过去
  await kit.sleep(220)
  return ok
}

export interface KeysSeen {
  /** 按 Cmd/Ctrl+Alt+B：收起、再按：打开 */
  closed: boolean
  reopened: boolean
  /** 焦点在输入框里的时候按也管用 */
  fromComposer: boolean
  /** 人打开面板：焦点进到面板里 */
  focusInside: boolean
  /** 标签栏上的收起按钮 */
  hidByButton: boolean
  /** 焦点在左边那条上，按三下左、三下右：宽度各是多少 */
  widths: number[]
  /** 树和内容之间那一条，按两下右、两下左：树各多宽 */
  treeWidths: number[]
  /** 按住左边那条往左拖 48 像素、再拖回来：面板各多宽 */
  dragged: number[]
  /** 按住树和内容之间那一条往右拖 32 像素、再拖回来：树各多宽 */
  treeDragged: number[]
  savedWidth: number
}

export async function keysSeen(): Promise<KeysSeen> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { one, until, frame, sleep } = kit
  const chord = (target: EventTarget) =>
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '∫',
        code: 'KeyB',
        altKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  await sleep(220)
  chord(document.body)
  const closed = await kit.seen(() => !kit.sideOpen(), 3000)
  await sleep(220)
  const area = one<HTMLTextAreaElement>('textarea.cmp-text')
  area?.focus()
  chord(area ?? document.body)
  const reopened = await kit.seen(() => kit.sideOpen(), 3000)
  const fromComposer = reopened && area !== null
  const focusInside = await kit.seen(
    () => kit.side()?.contains(document.activeElement) === true,
    3000,
  )
  await sleep(220)
  one<HTMLButtonElement>('.side-tabs [data-tool="hide"]')?.click()
  const hidByButton = await kit.seen(() => !kit.sideOpen(), 3000)
  await sleep(220)
  kit.toggle()
  await until('面板打开', () => kit.sideOpen())

  const panel = kit.side() as HTMLElement
  const grip = one('.side-grip') as HTMLElement
  const widths = [panel.offsetWidth]
  for (const key of ['ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowRight', 'ArrowRight']) {
    kit.press(grip, key)
    await frame()
    await frame()
    widths.push(panel.offsetWidth)
  }
  kit.press(grip, 'ArrowRight')
  await frame()
  await frame()
  widths.push(panel.offsetWidth)

  const treeBox = one('.ft') as HTMLElement
  const treeGrip = one('.ft-grip') as HTMLElement
  const treeWidths = [treeBox.offsetWidth]
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft']) {
    kit.press(treeGrip, key)
    await frame()
    await frame()
    treeWidths.push(treeBox.offsetWidth)
  }
  // 拖：鼠标的指针编号是 1。按住一条、横着挪 by 像素（分几步），松手
  const drag = async (handle: HTMLElement, by: number) => {
    const box = handle.getBoundingClientRect()
    const x = box.left + box.width / 2
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
  }
  const dragged = [panel.offsetWidth]
  // 面板靠右：往左拖是变宽
  await drag(grip, -48)
  dragged.push(panel.offsetWidth)
  await drag(grip, 48)
  dragged.push(panel.offsetWidth)
  const treeDragged = [treeBox.offsetWidth]
  await drag(treeGrip, 32)
  treeDragged.push(treeBox.offsetWidth)
  await drag(treeGrip, -32)
  treeDragged.push(treeBox.offsetWidth)

  const saved = JSON.parse(localStorage.getItem('litch.side') ?? '{}') as { width?: number }
  return {
    closed,
    reopened,
    fromComposer,
    focusInside,
    hidByButton,
    widths,
    treeWidths,
    dragged,
    treeDragged,
    savedWidth: saved.width ?? 0,
  }
}

export interface ReloadSeen {
  /** 重新加载之后，还没点任何会话的时候：面板是不是开着、多宽、焦点有没有被它抢走 */
  openAtStart: boolean
  widthAtStart: number
  stoleFocus: boolean
  /** 点回原来的会话：树从根开始（这次运行里记的展开和开着的文件没了，那本来就只记在一次运行里） */
  rows: number
  tabs: number
}

/** 页面重新加载之后（核心重启）。要先重新装一次工具 */
export async function reloadSeen(session: string): Promise<ReloadSeen> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { until, one } = kit
  await until('侧栏里有会话', () => one('.ss-row'), 40_000)
  // 面板是用到时才装载的那一块：上次开着的话，启动之后它自己会出来
  const openAtStart = await kit.seen(() => kit.sideOpen(), 5000)
  const widthAtStart = kit.side()?.offsetWidth ?? 0
  const stoleFocus = kit.side()?.contains(document.activeElement) === true
  await kit.openSession(session)
  await until('树取到了根', () => kit.rows().length > 0, 30_000)
  return { openAtStart, widthAtStart, stoleFocus, rows: kit.rowCount(), tabs: kit.tabs().length }
}
