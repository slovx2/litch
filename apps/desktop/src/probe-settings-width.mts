// 设置页验收里对话区宽度那一段：外观里的“对话区宽度”两档（宽 1280、紧凑 760），在几种窗口宽度、侧面板开合下，
// 正文、输入框、用户气泡各画多宽。规矩写在界面的 styles/transcript.css 开头，判定在 probe-settings-judge.mts。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。
import type { SettingsKit } from './probe-settings-kit.mjs'

export interface WidthSeen {
  /** 页面多宽（样式的像素） */
  inner: number
  chatWidth: string
  /** 侧面板开着没有 */
  side: boolean
  /** 对话区（.main）多宽、滚动区里面能放内容的地方多宽（滚动条要是占地方就少那么多） */
  main: number
  scroll: number
  /** 正文（.tr 去掉左右留白）多宽、左右留白各多少 */
  body: number
  gutter: number
  /** 输入区（.dock-in）多宽、它外面那一层左右各留多少 */
  dock: number
  dockGutter: number
  /** 信息栏多宽，没出就是 0 */
  rail: number
  /** 最宽的那个用户气泡 */
  bubble: number
}

export async function widthSeen(
  title: string,
  chatWidth: string,
  side: boolean,
): Promise<WidthSeen> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { one, all } = kit
  kit.look.set({ chatWidth } as Record<string, string>)
  await kit.openSession(title)
  await kit.settled()
  const tr = one('.tr') as HTMLElement
  const style = getComputedStyle(tr)
  const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  const dock = one('.dock') as HTMLElement | null
  return {
    inner: window.innerWidth,
    chatWidth,
    side,
    main: one('.main')?.offsetWidth ?? 0,
    scroll: one('.tr-scroll')?.clientWidth ?? 0,
    body: Math.round(tr.getBoundingClientRect().width - pad),
    gutter: parseFloat(style.paddingLeft),
    dock: one('.dock-in')?.offsetWidth ?? 0,
    dockGutter: dock ? parseFloat(getComputedStyle(dock).paddingLeft) : -1,
    rail: one('.rail')?.offsetWidth ?? 0,
    bubble: Math.max(0, ...all('.tr .umsg').map((bubble) => bubble.offsetWidth)),
  }
}

/** 外观里本来是哪一档（新的用户数据目录，没选过） */
export function widthAtStart(): string {
  return document.documentElement.dataset.chatWidth ?? ''
}

/** 哪些不合格。正文和输入框的宽度照 styles/transcript.css 开头的规矩算：最宽 1280 或 760，左右留白 24，所在那一栏窄于 600 时 16 */
export function judgeWidths(start: string, rows: WidthSeen[]): string[] {
  const failed: string[] = []
  if (start !== 'wide') failed.push(`没选过的时候对话区宽度是“${start}”，该是“wide”`)
  const most = (row: WidthSeen) => (row.chatWidth === 'wide' ? 1280 : 760)
  const gutterOf = (room: number) => (room < 600 ? 16 : 24)
  for (const row of rows) {
    const name = `页面 ${row.inner}、侧面板${row.side ? '开' : '关'}、${row.chatWidth}`
    const gutter = gutterOf(row.scroll)
    if (row.gutter !== gutter) failed.push(`${name}：正文左右留白 ${row.gutter}，该是 ${gutter}`)
    const body = Math.min(most(row), row.scroll - 2 * gutter)
    if (Math.abs(row.body - body) > 1) failed.push(`${name}：正文宽 ${row.body}，该是 ${body}`)
    const dockGutter = gutterOf(row.main)
    if (row.dockGutter !== dockGutter)
      failed.push(`${name}：输入区左右留白 ${row.dockGutter}，该是 ${dockGutter}`)
    const dock = Math.min(most(row), row.main - 2 * dockGutter)
    if (Math.abs(row.dock - dock) > 1) failed.push(`${name}：输入框宽 ${row.dock}，该是 ${dock}`)
    if (row.bubble > Math.min(760, row.body * 0.82) + 1)
      failed.push(`${name}：用户气泡宽 ${row.bubble}，超过了 760 或正文的 82%`)
  }
  // 对话区不到 808 时两档画出来一样
  for (const wide of rows.filter((row) => row.chatWidth === 'wide' && row.main <= 808)) {
    const narrow = rows.find(
      (row) => row.chatWidth === 'compact' && row.inner === wide.inner && row.side === wide.side,
    )
    if (narrow && (narrow.body !== wide.body || narrow.dock !== wide.dock))
      failed.push(
        `页面 ${wide.inner}、侧面板${wide.side ? '开' : '关'}：对话区只有 ${wide.main}，两档却不一样（${wide.body} / ${narrow.body}）`,
      )
  }
  if (!rows.some((row) => row.chatWidth === 'wide' && row.body > 760))
    failed.push('量过的窗口里宽档的正文没有一次比 760 宽：窗口没放大，或者宽档没起作用')
  return failed
}
