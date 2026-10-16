// 文件面板的验收（模拟核心那一种）量到的东西合不合格：这一半管树、查看器、找文件。
// 另一半（菜单、链接、换地方、外观、面板这个框）在 probe-files-judge-rest.mts。线划在哪、为什么，写在各条旁边。
import type { TreeSeen } from './probe-files.mjs'
import type { SearchSeen, ViewSeen } from './probe-files-view.mjs'

/**
 * 时间上的线。严的一套只在够快的机器上划（开发用的机器），都留了几倍的余量：
 * - 展开三万个条目的目录，点下去到画出来：模拟核心 1 秒（实测一百多毫秒），真的设备 4 秒（要真的读三万个目录项、过一道连接）；
 * - 展开、滚动、开大文件的时候两帧之间最长 300 毫秒：再长就是人看得出来的一顿。滚动时帧间隔的中位数过了 34 就是掉到三十帧以下；
 * - 六千行的文件，点下去到内容出来 1.5 秒、到颜色上完 4 秒（上色在工作线程里，不占界面）；
 * - 点对话里的链接到定位好 3 秒；找文件到出结果 6 秒（对面要现列一遍整棵树）。
 * 宽的一套给慢机器（流水线的虚拟机，或者 LITCH_CHECK_LENIENT=1）：这些只报数不划线，只留“卡死了”的线：一帧 5 秒。
 * 真把界面堵住的话（比如三万行全画出来），一帧会是好几秒甚至更长，照样拦得住。
 */
export interface FileLines {
  expandMs: number | null
  realExpandMs: number | null
  frameMaxMs: number
  frameMedianMs: number | null
  shownMs: number | null
  paintedMs: number | null
  jumpMs: number | null
  searchMs: number | null
}

export const STRICT_FILE_LINES: FileLines = {
  expandMs: 1000,
  realExpandMs: 4000,
  frameMaxMs: 300,
  frameMedianMs: 34,
  shownMs: 1500,
  paintedMs: 4000,
  jumpMs: 3000,
  searchMs: 6000,
}

export const LENIENT_FILE_LINES: FileLines = {
  expandMs: null,
  realExpandMs: null,
  frameMaxMs: 5000,
  frameMedianMs: null,
  shownMs: null,
  paintedMs: null,
  jumpMs: null,
  searchMs: null,
}

/** 一屏最多画这么多行算正常（看得见的加上上下各多画的一截）。三万行都画出来的话是几万 */
export const DOM_ROWS_MAX = 150

export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
export const longest = (values: number[]): number => Math.max(0, ...values)
export const ms = (value: number): string => `${value.toFixed(0)} ms`

/** 一段帧间隔合不合线。what：是做什么的时候量的 */
export function judgeGaps(
  what: string,
  gaps: number[],
  lines: FileLines,
  withMedian: boolean,
): string[] {
  const failed: string[] = []
  if (longest(gaps) > lines.frameMaxMs)
    failed.push(`${what}的时候卡了一下：最长一帧 ${ms(longest(gaps))}，线是 ${lines.frameMaxMs} ms`)
  if (withMedian && lines.frameMedianMs !== null && median(gaps) > lines.frameMedianMs)
    failed.push(
      `${what}的时候帧率掉了：帧间隔中位 ${median(gaps).toFixed(1)} ms，线是 ${lines.frameMedianMs} ms`,
    )
  return failed
}

export function judgeTree(tree: TreeSeen, lines: FileLines): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(tree.startsClosed, '侧面板一开始应该是收着的')
  must(tree.opened && tree.pressed, '点标题栏的按钮没有打开侧面板，或者按钮不是按下的样子')
  must(
    tree.tab === 'files' && tree.tabLabel === '文件',
    `打开之后看的不是“文件”标签：${tree.tab}（${tree.tabLabel}）`,
  )
  must(tree.focusInTree, '人打开面板之后焦点不在文件树上')
  must(
    tree.place === 'local/litch' && tree.root === '~/work/litch',
    `面板没有挂在眼前会话的工作区上：${tree.place}｜${tree.root}`,
  )
  const firstFile = tree.rootRows.findIndex((row) => row.startsWith('file:'))
  must(
    firstFile > 0 && !tree.rootRows.slice(firstFile).some((row) => row.startsWith('dir:')),
    `根下面不是目录在前：${tree.rootRows.join(' ')}`,
  )
  must(
    !tree.rootRows.some((row) => row.split(':')[1]?.startsWith('.')),
    `没开“显示隐藏文件”就看见了隐藏的：${tree.rootRows.join(' ')}`,
  )
  must(
    tree.rootAsked === 1 && tree.askedAtStart.join('|') === '',
    `刚打开的时候应该只问过根这一层、只问一次：根 ${tree.rootAsked} 次，问过的有 ${JSON.stringify(tree.askedAtStart)}`,
  )
  // ---- 三万个条目 ----
  const { many, scroll } = tree
  must(many.rows > 30_000, `三万个条目的目录展开之后行数不对：${many.rows}`)
  must(many.dom <= DOM_ROWS_MAX, `展开之后页面上画了 ${many.dom} 行，应该只画看得见的那些`)
  must(many.asked === 1, `三万个条目的那一层向设备问了 ${many.asked} 次，应该是 1 次`)
  must(many.head[0] === 'group-00', `展开之后头一行不是目录：${many.head.join(' ')}`)
  must(
    lines.expandMs === null || many.ms <= lines.expandMs,
    `展开三万个条目的目录太慢：${ms(many.ms)}，线是 ${lines.expandMs} ms`,
  )
  failed.push(...judgeGaps('展开三万个条目的目录', many.gaps, lines, false))
  must(scroll.tail === 'item-29959.txt', `滚到底，最后一行不对：${scroll.tail}`)
  must(
    scroll.mid === scroll.midWanted,
    `滚到中间，那一行画的不是它：${scroll.mid}，该是 ${scroll.midWanted}`,
  )
  must(scroll.domMax <= DOM_ROWS_MAX, `滚动的时候页面上最多画了 ${scroll.domMax} 行`)
  must(scroll.blank === 0, `滚动的时候有 ${scroll.blank} 帧看得见的地方是空的`)
  failed.push(...judgeGaps('在三万行里滚动', scroll.gaps, lines, true))
  must(
    tree.reexpand.asked === 1 && tree.reexpand.rows === many.rows,
    `收起再马上展开：这一层问了 ${tree.reexpand.asked} 次（应该还是 1 次），行数 ${tree.reexpand.rows}`,
  )
  must(tree.afterCollapse < 100, `收起三万个条目的目录之后树里还有 ${tree.afterCollapse} 行`)
  // ---- 说明行、符号链接、隐藏文件 ----
  must(tree.emptyNote === '空的', `空目录下面的说明不对：${tree.emptyNote}`)
  must(
    tree.lockedNote.startsWith('没读到：') && tree.lockedRetry,
    `列不了的目录没有说明原因，或者没有“重试”：${tree.lockedNote}`,
  )
  must(
    tree.linkKind === 'dir' && tree.linkChildren.includes('guide.md'),
    `指向目录的符号链接没有当目录显示：${tree.linkKind}（${tree.linkChildren.join(' ')}）`,
  )
  must(
    tree.hiddenShown.includes('.github') && tree.hiddenShown.includes('.gitignore'),
    `打开“显示隐藏文件”没有多出隐藏的：${tree.hiddenShown.join(' ')}`,
  )
  must(
    tree.hiddenPressed && tree.hiddenGone,
    '“显示隐藏文件”的按钮没有按下的样子，或者关上之后隐藏的还在',
  )
  // ---- 键盘 ----
  const name = (row: string | undefined) => row?.split(':')[1] ?? ''
  const top = name(tree.rootRows[0])
  const wantKeys = [
    `Home→${top}`,
    `ArrowDown→${name(tree.rootRows[1])}`,
    `ArrowUp→${top}`,
    `ArrowRight→${top}（开）`,
    null,
    `ArrowLeft→${top}（开）`,
    `ArrowLeft→${top}`,
    `End→${name(tree.rootRows.at(-1))}`,
  ]
  wantKeys.forEach((want, index) => {
    const got = tree.keys[index] ?? ''
    if (want === null) must(got.startsWith(`ArrowRight→${top}/`), `往右没有走进目录里：${got}`)
    else must(got === want, `键盘第 ${index + 1} 步不对：${got}，该是 ${want}`)
  })
  must(
    tree.refresh[1] === tree.refresh[0] + 1,
    `刷新应该让根这一层再问一次：之前 ${tree.refresh[0]} 次，之后 ${tree.refresh[1]} 次`,
  )
  must(tree.untouched.includes('packages'), '没展开过的目录被问过了：不是懒加载')
  return failed
}

export function judgeView(view: ViewSeen, lines: FileLines): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(view.none !== '', '没开文件的时候查看器里没有说明')
  const wantSteps = [
    '单击 README.md：README.md*~',
    '单击 Makefile：Makefile*~',
    '双击 package.json：package.json*',
    '单击 AGENTS.md：package.json AGENTS.md*~',
    '双击 AGENTS.md 的标签：package.json AGENTS.md*',
    '单击 README.md：package.json AGENTS.md README.md*~',
    '关掉 AGENTS.md：package.json README.md*~',
    '点 package.json 的标签：package.json* README.md~',
  ]
  wantSteps.forEach((want, index) => {
    must(
      view.steps[index] === want,
      `预览与固定第 ${index + 1} 步不对：${view.steps[index]}，该是 ${want}`,
    )
  })
  must(view.language === 'markdown', `README.md 的语言没认出来：${view.language}`)
  must(view.paint === 'worker', `上色没有走工作线程：${view.paint}`)
  must(view.spans > 0, '文件没有上色')
  must(view.foot.includes('行') && view.readonly, `查看器底下那一条不对：${view.foot}`)
  must(view.selectedFollows, '树里选中的没有跟着正看着的文件走')
  must(
    view.reloads[1] === view.reloads[0] + 1,
    `“重新读取”应该再读一次：之前 ${view.reloads[0]} 次，之后 ${view.reloads[1]} 次`,
  )
  const { long } = view
  must(long.mode === 'worker', `六千行的文件上色没有走工作线程：${long.mode}`)
  must(long.lines >= 6000, `六千行的文件行数不对：${long.lines}`)
  must(long.dom <= DOM_ROWS_MAX, `六千行的文件页面上画了 ${long.dom} 行，应该只画看得见的`)
  must(long.farShown && long.farPainted, '滚到第三千行：那一行没画出来，或者没上色')
  must(long.blank === 0, `在六千行的文件里滚动，有 ${long.blank} 帧看得见的地方是空的`)
  must(long.scrollDrift <= 2, `换走再换回来，滚动位置差了 ${long.scrollDrift} 像素`)
  must(
    lines.shownMs === null || long.shownMs <= lines.shownMs,
    `六千行的文件内容出来得太慢：${ms(long.shownMs)}，线是 ${lines.shownMs} ms`,
  )
  must(
    lines.paintedMs === null || long.paintedMs <= lines.paintedMs,
    `六千行的文件上色太慢：${ms(long.paintedMs)}，线是 ${lines.paintedMs} ms`,
  )
  failed.push(...judgeGaps('打开六千行的文件、给它上色', long.gaps, lines, false))
  failed.push(...judgeGaps('在六千行的文件里滚动', long.rollGaps, lines, true))
  must(view.minifiedPaint === 'none', `一行特别长的文件不该上色：${view.minifiedPaint}`)
  must(
    view.minifiedCut !== '' && view.minifiedShown < 4300,
    `特别长的那一行没有截断：显示了 ${view.minifiedShown} 个字`,
  )
  const kinds = view.holds.map((hold) => hold.split('｜').slice(0, 2).join('｜'))
  must(
    kinds.join(' ') ===
      'fixtures/big.log｜tooLarge fixtures/blob.dat｜binary docs/images/shot.png｜binary fixtures/gone.txt｜missing',
    `显示不了的文件占位不对：${view.holds.join(' ／ ')}`,
  )
  must(view.holds[2]?.includes('这是图片') === true, `图片的占位没有说是图片：${view.holds[2]}`)
  must(
    view.lossyText === 'caf\uFFFD' && view.lossyPill === '编码不明',
    `不是 UTF-8 的文件：显示成 ${JSON.stringify(view.lossyText)}，标记 ${view.lossyPill}`,
  )
  must(view.htmlAsText && view.htmlLeaked === '', `文件里的标记没有只当字显示：${view.htmlLeaked}`)
  return failed
}

export function judgeSearch(search: SearchSeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(search.hits[0] === 'file:scripts/tool.py', `找 toolpy 的结果不对：${search.hits.join(' ')}`)
  must(search.marked === 'toolpy', `结果里标出来的字不对：${search.marked}`)
  must(
    search.parentAsked === 0,
    '找之前 scripts 这一层已经被列过了：量不出结果是不是从整棵树里找的',
  )
  must(search.walked.join(',') === '0,1,0', `上下键在结果里走得不对：${search.walked.join(',')}`)
  must(search.hitMenu === 3, `结果上点右键，菜单里有 ${search.hitMenu} 项`)
  must(search.opened === 'scripts/tool.py', `回车没有固定打开第一条：${search.opened}`)
  must(search.cleared && search.revealed, '按 Esc 回到树上，找到的那个文件没有露出来、选中')
  must(search.none === '没有找到。', `找不到的时候写的不对：${search.none}`)
  must(
    search.dirHit === 'fixtures/many/group-17' && search.dirRevealed,
    `点找到的目录，没有在树里露出来：${search.dirHit}`,
  )
  return failed
}
