// 文件面板的验收，对着真的文件系统（接 probe-files-real.mts）：查看文件、各种占位、
// 对话里提到的路径点得开并定位到行、换会话面板跟着换。
import type { FilesKit } from './probe-files-kit.mjs'

export interface RealJump {
  label: string
  file: string
  line: number | null
  inView: boolean
  marked: boolean
  /** 那一行上写的什么 */
  text: string
  ms: number
}

export interface RealView {
  /** 一个小的文字文件：认出的语言、上色走的哪条路、行数、第一行 */
  language: string
  paint: string
  lines: number
  firstLine: string
  /** 指向文件的符号链接：读到的第一行 */
  viaFileLink: string
  /** 断了的符号链接：树上是什么、点开是什么占位 */
  brokenKind: string
  brokenHold: string
  /** 六千行的文件：到内容出来、到颜色上完各多久，帧间隔，行数，画了多少行 */
  longShownMs: number
  longPaintedMs: number
  longMode: string
  longGaps: number[]
  longLines: number
  longDom: number
  /** 各种显示不了的：每项写成“文件｜占位的种类｜标题” */
  holds: string[]
  /** 回答里认成了文件的链接，和没认成的行内代码 */
  links: string[]
  plain: string[]
  jumps: RealJump[]
  /** 工作目录在工作区的子目录里的会话：回答里相对于工作目录写的文件名点开的是谁（没有这样的会话就是空的） */
  cwdOpened: string
  cwdText: string
  /** 换到另一个根的会话：面板挂到哪了、根是谁、有没有行；换回来原来开着的文件还在 */
  otherRoot: string
  otherRows: number
  backTabs: number
}

export async function realView(args: {
  session: string
  other: string
  /** 工作目录在子目录里的那个会话；没有就不量 */
  cwdSession: string | null
}): Promise<RealView> {
  const kit = (window as unknown as { __filesKit: FilesKit }).__filesKit
  const { until, one, all, text, frame } = kit
  const relative = (path: string) => path.slice(kit.root().length + 1)
  const lineText = (line: number) => one(`.cl[data-line="${line}"] .lc`)?.textContent ?? ''

  await kit.open('notes.txt')
  const paint = await kit.painted()
  const view = kit.code() as HTMLElement
  const language = view.dataset.language ?? ''
  const lines = Number(view.dataset.lines ?? 0)
  const firstLine = lineText(1)
  await kit.open('link-file')
  await kit.painted()
  const viaFileLink = lineText(1)
  const brokenKind = kit.rows().find((row) => row.path === 'link-broken')?.kind ?? '（树上没有）'
  let brokenHold = ''
  if (kit.row('link-broken')) {
    await kit.open('link-broken')
    brokenHold = (await until('断链的占位', () => one<HTMLElement>('.fv-hold'))).dataset.hold ?? ''
  }

  await kit.expand('src')
  const longRow = await kit.rowShown('src/long.ts')
  const opened = await kit.frames(async () => {
    const started = performance.now()
    kit.click(longRow)
    await kit.viewed('src/long.ts', 60_000)
    const shownMs = performance.now() - started
    const mode = await kit.painted(60_000)
    return { shownMs, paintedMs: performance.now() - started, mode }
  })
  const longView = kit.code() as HTMLElement
  const longLines = Number(longView.dataset.lines ?? 0)
  const longDom = all('.cl', longView).length

  const holds: string[] = []
  for (const file of ['big.log', 'blob.dat', 'shot.png']) {
    await kit.open(file)
    const hold = await until(`${file} 的占位`, () => one<HTMLElement>('.fv-hold'), 60_000)
    holds.push([file, hold.dataset.hold, text(one('b', hold))].join('｜'))
  }

  // ---------- 对话里的路径 ----------
  const turnsBefore = all('.turn').length
  // 假模型会把这句话原样带回来：回答里就有了这几个路径
  await kit.say(
    '看看 `src/long.ts:4200` 和 `notes.txt:12`，还有 `src/app.ts`；`../../outside/secret.txt` 不在工作区里，`console.log` 不是文件。',
  )
  const turn = await until(
    '带路径的回答',
    () => {
      const last = all('.turn').at(-1)
      return all('.turn').length > turnsBefore &&
        !one('.running-line') &&
        all('.md a.file-link', last).length >= 3
        ? last
        : null
    },
    90_000,
  )
  const anchors = all('.md a.file-link', turn)
  const links = anchors.map(
    (anchor) =>
      `${text(anchor)}→${relative(anchor.dataset.file ?? '')}${anchor.dataset.line ? `:${anchor.dataset.line}` : ''}`,
  )
  const plain = all('.md code', turn)
    .filter((code) => !one('a.file-link', code))
    .map(text)
  const jumps: RealJump[] = []
  for (const label of ['src/long.ts:4200', 'notes.txt:12', 'src/app.ts']) {
    const anchor = anchors.find((entry) => text(entry) === label)
    if (!anchor) throw new Error(`回答里没有这个链接：${label}（有：${links.join('，')}）`)
    const file = relative(anchor.dataset.file ?? '')
    const line = anchor.dataset.line ? Number(anchor.dataset.line) : null
    const started = performance.now()
    kit.click(anchor)
    await kit.viewed(file, 60_000)
    const inView = line === null ? true : await kit.seen(() => kit.lineInView(line), 10_000)
    const ms = performance.now() - started
    await frame()
    jumps.push({
      label,
      file,
      line,
      inView,
      marked:
        line === null ? !one('.cl.hl') : one('.cl.hl')?.getAttribute('data-line') === String(line),
      text: lineText(line ?? 1),
      ms,
    })
  }
  const tabsBefore = kit.tabs().length

  // ---------- 工作目录在子目录里的会话 ----------
  let cwdOpened = ''
  let cwdText = ''
  if (args.cwdSession) {
    await kit.openSession(args.cwdSession)
    const anchor = await until('回答里的 status.txt', () =>
      all('.md a.file-link').find((entry) => text(entry) === 'status.txt'),
    )
    kit.click(anchor)
    cwdOpened = relative(anchor.dataset.file ?? '')
    await kit.viewed(cwdOpened, 30_000)
    await kit.painted()
    cwdText = lineText(1)
  }

  // ---------- 换到另一个根的会话 ----------
  const home = kit.root()
  await kit.openSession(args.other)
  await until('根换了', () => kit.root() !== '' && kit.root() !== home, 30_000)
  await until('那棵树有了结果', () => kit.rows().length > 0 || one('.ft-hold'), 30_000)
  const otherRoot = kit.root()
  const otherRows = kit.rowCount()
  await kit.openSession(args.session)
  await until('根换回来了', () => kit.root() === home, 30_000)
  const backTabs = kit.tabs().length - tabsBefore

  return {
    language,
    paint,
    lines,
    firstLine,
    viaFileLink,
    brokenKind,
    brokenHold,
    longShownMs: opened.value.shownMs,
    longPaintedMs: opened.value.paintedMs,
    longMode: opened.value.mode,
    longGaps: opened.gaps,
    longLines,
    longDom,
    holds,
    links,
    plain,
    jumps,
    cwdOpened,
    cwdText,
    otherRoot,
    otherRows,
    backTabs,
  }
}
