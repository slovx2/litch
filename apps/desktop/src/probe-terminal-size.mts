// 终端验收里量大小的两段：改窗口大小之后的行列数、调面板高度。
// 两处等的都是“对上了”这个状态，不是一段时间：终端重排、再把新的行列数告诉对面，慢机器上要多久说不准。
import type { TerminalKit } from './probe-terminal-kit.mjs'

export interface SizeSeen {
  /** 终端里的程序看到的行列数（假 shell 的 size、真 shell 的 stty size） */
  told: string
  /** 屏幕上实际画了几行、一行排了几个字 */
  rows: number
  cols: number
  /** 问了几遍才对上（窗口大小刚变的时候，头一遍可能赶在新的行列数告诉对面之前） */
  asked: number
}

/**
 * 问终端里的程序现在多大，再从画面上数一遍。command：size 或者 stty size。
 * width、height：窗口里的页面现在应该是多大（主进程刚改的），先等页面收到。
 */
export async function sizeSeen(command: string, width: number, height: number): Promise<SizeSeen> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, frame } = kit
  await until(
    `页面收到新的窗口大小 ${width}×${height}（现在 ${window.innerWidth}×${window.innerHeight}）`,
    () => window.innerWidth === width && window.innerHeight === height,
  )
  // 终端跟着容器的大小重排，是收到之后那一帧里的事
  await frame()
  await frame()
  if (kit.tabs().length === 0) {
    one<HTMLButtonElement>('.term-empty [data-tool="new"]')?.click()
    await until('开一个终端', () => kit.tabs().length === 1)
  }
  await kit.prompt()
  const measure = async (): Promise<Omit<SizeSeen, 'asked'>> => {
    // 窗口大小刚变的时候，这一下可能赶在新的行列数告诉对面之前（界面攒 60 毫秒才发）：所以下面要一直问到对上
    kit.run('clear')
    await kit.cleared()
    kit.run(command)
    const told = await until('行列数', kit.sizeTold)
    await kit.prompt()
    // 一行排几个字：打一串比一行长的字，看它在第几个字折行
    kit.run('clear')
    await kit.cleared()
    kit.run(`echo ${'0123456789'.repeat(40)}`)
    // 命令自己和它的结果都要折行：等到折出来的行够多，再等提示符回来
    await until('折了行', () => kit.rows().filter((row) => /^\d+$/.test(row)).length >= 3)
    await kit.prompt()
    // 整行都是数字的那些行里最长的，就是排满了的一行
    const cols = Math.max(
      0,
      ...kit
        .rows()
        .filter((row) => /^\d+$/.test(row))
        .map((row) => row.length),
    )
    return { told, rows: kit.rows().length, cols }
  }
  const end = performance.now() + 20_000
  for (let asked = 1; ; asked++) {
    const seen = await measure()
    if (seen.told === `${seen.rows} ${seen.cols}` || performance.now() >= end) {
      return { ...seen, asked }
    }
    await kit.sleep(100)
  }
}

export interface HeightSeen {
  /** 面板原来多高、屏幕上几行 */
  before: number
  rowsBefore: number
  /** 焦点在顶边那一条上按三次向上键：高了多少、行数跟着多了、记下来的高度 */
  afterKeys: number
  rowsAfterKeys: number
  saved: number
  /** 按住顶边往下拖 48 像素：矮了多少 */
  afterDrag: number
  /** 这时候终端里的程序看到的行数，和屏幕上的行数 */
  told: string
  rowsAfterDrag: number
}

export async function heightSeen(): Promise<HeightSeen> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, frame } = kit
  const dock = kit.panel()
  const grip = one('.term-grip')
  if (!dock || !grip) throw new Error('没找到面板的顶边')
  await kit.prompt()
  const before = dock.offsetHeight
  const rowsBefore = kit.rows().length
  grip.focus()
  // 一次按键挪 24 像素：按一下等它挪到了再按下一下
  for (let count = 1; count <= 3; count++) {
    grip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    await kit.seen(() => dock.offsetHeight >= before + 24 * count, 3000)
  }
  await until('面板变高了', () => dock.offsetHeight > before)
  await until('行数跟着多了', () => kit.rows().length > rowsBefore)
  const afterKeys = dock.offsetHeight
  const rowsAfterKeys = kit.rows().length
  const saved = (JSON.parse(localStorage.getItem('litch.terminal') ?? '{}') as { height?: number })
    .height
  // 拖：鼠标的指针编号是 1
  const box = grip.getBoundingClientRect()
  const at = (clientY: number): PointerEventInit => ({
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 1,
    clientX: box.left + box.width / 2,
    clientY,
    bubbles: true,
    cancelable: true,
  })
  const y = box.top + box.height / 2
  grip.dispatchEvent(new PointerEvent('pointerdown', at(y)))
  for (const step of [12, 24, 36, 48]) {
    grip.dispatchEvent(new PointerEvent('pointermove', at(y + step)))
    await frame()
  }
  grip.dispatchEvent(new PointerEvent('pointerup', at(y + 48)))
  await kit.seen(() => dock.offsetHeight === afterKeys - 48, 3000)
  const afterDrag = dock.offsetHeight
  // 终端按新的高度重排、把新的行数告诉对面之后，程序才看得到：一直问到对上
  const told = await kit.rowsAgreed('size')
  return {
    before,
    rowsBefore,
    afterKeys,
    rowsAfterKeys,
    saved: saved ?? 0,
    afterDrag,
    told,
    rowsAfterDrag: kit.rows().length,
  }
}
