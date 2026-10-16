// 文件面板的验收：侧面板和主区域里那几行（对话、请求卡片、输入区、终端面板）摆在一起的时候。
// 窗口缩到最窄、面板开着：输入框整个看得见，请求卡片没被挤没，面板没有压到对话上；
// 新建对话页上面板跟着页上选的设备和项目走；面板一开一合，终端的行列数跟得上。
// 主进程在这几段之间改窗口大小，编排在 probe-files-run.mts。
import type { FilesKit } from './probe-files-kit.mjs'
import type { TerminalKit } from './probe-terminal-kit.mjs'

export interface RoomSeen {
  /** 面板怎么放的、多宽；对话区多宽 */
  mode: string
  side: number
  main: number
  /** 文件标签是不是改成了上下摆（树在上、内容在下，都是整个面板那么宽） */
  stacked: boolean
  /** 带请求卡片的会话：出的岔子（没有就是空的）、卡片多高、输入框多高 */
  faults: string
  cardHeight: number
  inputHeight: number
  /** 新建对话页：输入框那里出的岔子 */
  newPageFaults: string
}

/**
 * 窗口已经缩到最窄（主进程缩的）、面板开着：打开一个有请求等着回答的会话量一遍，再到新建对话页量一遍。
 * inner、innerHeight：窗口里的页面现在应该是多大，先等页面收到
 */
export async function roomSeen(
  waiting: string,
  inner: number,
  innerHeight: number,
): Promise<RoomSeen> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { until, one, frame } = kit
  await kit.seen(() => window.innerWidth === inner && window.innerHeight === innerHeight, 5000)
  await kit.openSession(waiting)
  await until('请求卡片', () => one('.req'), 30_000)
  await until('面板跟到了这个会话', () => kit.sideOpen() && kit.rows().length > 0)
  for (let count = 0; count < 4; count++) await frame()

  /** 输入框那一块摆得对不对。card：卡片（没有就不看卡片） */
  const faultsOf = (card: HTMLElement | null): string => {
    const found: string[] = []
    const main = one('.main')?.getBoundingClientRect()
    const panel = kit.side()?.getBoundingClientRect()
    const box = one('.dock .cmp')?.getBoundingClientRect()
    const field = one<HTMLTextAreaElement>('.dock textarea.cmp-text')
    if (!main || !panel || !box || !field) return '输入框或者面板不在'
    if (panel.left < main.right - 0.5) found.push('面板压到了对话区上')
    if (panel.right > window.innerWidth + 0.5) found.push('面板伸到了窗口外面')
    if (
      box.top < main.top - 0.5 ||
      box.bottom > Math.min(main.bottom, window.innerHeight) + 0.5 ||
      box.left < main.left - 0.5 ||
      box.right > main.right + 0.5
    ) {
      found.push('输入框伸到了对话区外面')
    }
    // 没有被别的东西盖住：输入框正中那一点上就是它自己
    const at = field.getBoundingClientRect()
    if (document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2) !== field) {
      found.push('输入框被盖住了')
    }
    // 输入框底下那一排（加图片、模型、强度、权限、发送）：地方再窄也不能互相压住
    const boxes = kit
      .all('.dock .cmp-bar :is(.pick-btn, .ibtn, .send)')
      .map((entry) => entry.getBoundingClientRect())
      .filter((entry) => entry.width > 0)
      .sort((a, b) => a.left - b.left)
    if (
      boxes.some((entry, index) => index > 0 && entry.left < (boxes[index - 1]?.right ?? 0) - 0.5)
    )
      found.push('输入框底下那一排互相压住了')
    if (card) {
      const frameBox = card.getBoundingClientRect()
      if (frameBox.bottom > box.top + 0.5) found.push('卡片压着输入框')
      if (frameBox.top < main.top - 0.5) found.push('卡片伸到了对话区上面')
      if (frameBox.right > main.right + 0.5) found.push('卡片伸到了面板底下')
      const acts = one('.req-actions', card)?.getBoundingClientRect()
      if (!acts) found.push('卡片没有底下那排按钮')
      else {
        if (acts.bottom > frameBox.bottom + 0.5 || acts.top < frameBox.top - 0.5)
          found.push('卡片底下那排按钮不在卡片里')
        // 那排按钮点得到：它正中那一点上是卡片里的东西
        const hit = document.elementFromPoint(
          acts.left + acts.width / 2,
          acts.top + acts.height / 2,
        )
        if (!hit || !card.contains(hit)) found.push('卡片底下那排按钮被盖住了')
      }
    }
    return found.join('、')
  }
  const card = one('.req')
  const faults = faultsOf(card)
  const cardHeight = Math.round(card?.getBoundingClientRect().height ?? 0)
  const inputHeight = Math.round(one('.dock .cmp')?.getBoundingClientRect().height ?? 0)
  const panel = kit.side()
  const tree = one('.ft')?.getBoundingClientRect()
  const view = one('.fv')?.getBoundingClientRect()
  const stacked = Boolean(
    tree && view && panel && tree.bottom <= view.top + 1 && view.width >= panel.offsetWidth - 2,
  )

  // 新建对话页：输入框在页面正中
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true, cancelable: true }),
  )
  await until('新建对话页', () => one('.new-hero'))
  for (let count = 0; count < 4; count++) await frame()
  const newPageFaults = faultsOf(null)
  return {
    mode: panel?.dataset.mode ?? '',
    side: panel?.offsetWidth ?? 0,
    main: one('.main')?.offsetWidth ?? 0,
    stacked,
    faults,
    cardHeight,
    inputHeight,
    newPageFaults,
  }
}

export interface NewPageSeen {
  /** 从一个会话按 Cmd/Ctrl+N 过来：面板挂在哪（设备/项目｜根），树有没有 */
  start: string
  startRows: number
  /** 在页上换了项目：面板跟着换到哪 */
  workspace: string
  /** 换成“无项目”：面板里写的什么 */
  noWorkspace: string
  /** 换了设备、再选那台设备上的一个项目：面板跟到哪 */
  device: string
}

export async function newPageSeen(args: {
  session: string
  workspace: string
  none: string
  device: string
  deviceWorkspace: string
}): Promise<NewPageSeen> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { until, one, all, text, frame } = kit
  const placeNow = () => {
    const panel = kit.side()
    return `${panel?.dataset.device}/${panel?.dataset.workspace}｜${kit.root()}`
  }
  /** 页上的一个选择器：device、workspace */
  const picker = (kind: string) => one<HTMLButtonElement>(`.pick[data-kind="${kind}"] .pick-btn`)
  const options = (kind: string) => all(`.pick[data-kind="${kind}"] .pick-opt`)
  const choose = async (kind: string, title: string) => {
    ;(await until(`“${kind}”的选择器`, () => picker(kind))).click()
    const option = await until(`“${kind}”里的“${title}”`, () =>
      options(kind).find((entry) => text(one('b', entry)) === title),
    )
    option.click()
    await until(`“${kind}”换成“${title}”`, () => text(picker(kind)) === title)
    await frame()
  }
  await kit.openSession(args.session)
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true, cancelable: true }),
  )
  await until('新建对话页', () => one('.new-hero'))
  await until('面板还挂着', () => kit.sideOpen() && kit.rows().length > 0)
  const start = placeNow()
  const startRows = kit.rows().length

  await choose('workspace', args.workspace)
  await until('面板换了根', () => placeNow() !== start && kit.rows().length > 0)
  const workspace = placeNow()

  await choose('workspace', args.none)
  const noWorkspace = text(await until('没有项目的说明', () => one('.side-body .side-none')))

  await choose('device', args.device)
  await choose('workspace', args.deviceWorkspace)
  await until('面板跟到了那台设备', () => kit.files() !== null && kit.rows().length > 0)
  const device = placeNow()
  // 页上选的去处会被记成“上次用的”：换回起头的地方，后面的不受影响
  await kit.openSession(args.session)
  return { start, startRows, workspace, noWorkspace, device }
}

/** 开着（或者收着）终端面板。量行列数之前用 */
export async function termPanel(open: boolean): Promise<boolean> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  if (kit.panelOpen() !== open) kit.toggle()
  const ok = await kit.seen(() => kit.panelOpen() === open, 5000)
  if (!open) return ok
  // 打开面板会顺手开出第一个终端：等它起来、提示符出来了再让人去量
  await kit.until('顺手开出一个终端', () => kit.tabs().length >= 1)
  await kit.prompt()
  return ok
}

/** 开着（或者收着）侧面板，等它到位。返回这时候对话区多宽 */
export async function sidePanel(open: boolean): Promise<number> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  // 开合有一小段防重的时间：上一次开合刚过的话等一等
  await kit.sleep(220)
  if (kit.sideOpen() !== open) kit.toggle()
  await kit.until(`侧面板${open ? '打开' : '收起'}`, () => kit.sideOpen() === open)
  await kit.sleep(220)
  return kit.one('.main')?.offsetWidth ?? 0
}
