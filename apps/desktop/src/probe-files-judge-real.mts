// 文件面板的验收（对着真的文件系统那两种）量到的东西合不合格。
// 夹具的临时目录里摆了什么，见 scripts/check-files.mjs 开头；这里照着那份布置判。
import {
  DOM_ROWS_MAX,
  type FileLines,
  judgeGaps,
  LENIENT_FILE_LINES,
  longest,
  median,
  ms,
  STRICT_FILE_LINES,
} from './probe-files-judge.mjs'
import type { RealTree } from './probe-files-real.mjs'
import type { RealView } from './probe-files-real-view.mjs'

/** 起验收的脚本告诉我们的：夹具里那几个目录在哪 */
export interface RealDirs {
  app: string
  notes: string
  outside: string
}

export interface RealSeen {
  tree: RealTree
  view: RealView
}

export function realNumbers(seen: RealSeen): string {
  const { tree, view } = seen
  return [
    `展开三万个条目的目录 ${ms(tree.manyMs)}（最长一帧 ${ms(longest(tree.manyGaps))}，${tree.manyRows} 行里画了 ${tree.manyDom} 行，这一层问了 ${tree.manyAsked} 次）`,
    `在里面滚动 帧间隔中位 ${median(tree.rollGaps).toFixed(1)} ms、最长 ${ms(longest(tree.rollGaps))}`,
    `找文件 ${ms(tree.searchMs)}`,
    `六千行的文件 内容 ${ms(view.longShownMs)}、上色 ${ms(view.longPaintedMs)}（${view.longMode}），这期间最长一帧 ${ms(longest(view.longGaps))}`,
    `点对话里的链接到定位好 最长 ${ms(longest(view.jumps.map((jump) => jump.ms)))}`,
  ].join('；')
}

function judgeRealTree(tree: RealTree, dirs: RealDirs, lines: FileLines): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(tree.root === dirs.app, `面板的根不是会话所在的项目：${tree.root}，该是 ${dirs.app}`)
  const firstFile = tree.rootRows.findIndex((row) => !row.startsWith('dir:'))
  must(
    firstFile > 0 && !tree.rootRows.slice(firstFile).some((row) => row.startsWith('dir:')),
    `根下面不是目录在前：${tree.rootRows.join(' ')}`,
  )
  // 符号链接：对面列目录时只说它“不是目录也不是文件”，要这一头补问了才知道
  for (const want of [
    'dir:empty',
    'dir:lib',
    'dir:link-dir',
    'dir:many',
    'dir:src',
    'file:link-file',
    'file:notes.txt',
    'file:big.log',
  ]) {
    must(tree.rootRows.includes(want), `根下面少了 ${want}：${tree.rootRows.join(' ')}`)
  }
  must(
    !tree.rootRows.some((row) => row.split(':')[1]?.startsWith('.')),
    `没开“显示隐藏文件”就看见了隐藏的：${tree.rootRows.join(' ')}`,
  )
  must(
    tree.hiddenShown.includes('.config') && tree.hiddenShown.includes('.hidden.txt'),
    `打开“显示隐藏文件”没有多出隐藏的：${tree.hiddenShown.join(' ')}`,
  )
  must(tree.rootAsked === 1, `根这一层向设备问了 ${tree.rootAsked} 次，应该是 1 次`)
  must(tree.manyRows > 30_000, `三万个条目的目录展开之后行数不对：${tree.manyRows}`)
  must(tree.manyDom <= DOM_ROWS_MAX, `展开之后页面上画了 ${tree.manyDom} 行，应该只画看得见的那些`)
  must(tree.manyAsked === 1, `三万个条目的那一层向设备问了 ${tree.manyAsked} 次，应该是 1 次`)
  must(tree.manyHead[0] === 'group-00', `展开之后头一行不是目录：${tree.manyHead.join(' ')}`)
  must(tree.tail === 'item-29999.txt', `滚到底，最后一行不对：${tree.tail}`)
  must(tree.blank === 0, `滚动的时候有 ${tree.blank} 帧看得见的地方是空的`)
  must(
    lines.realExpandMs === null || tree.manyMs <= lines.realExpandMs,
    `展开三万个条目的目录太慢：${ms(tree.manyMs)}，线是 ${lines.realExpandMs} ms`,
  )
  failed.push(...judgeGaps('展开三万个条目的目录', tree.manyGaps, lines, false))
  failed.push(...judgeGaps('在三万行里滚动', tree.rollGaps, lines, true))
  must(
    tree.reexpandAsked === 1,
    `收起再马上展开，这一层问了 ${tree.reexpandAsked} 次，应该还是 1 次`,
  )
  must(
    tree.linkDir.includes('file:long.ts'),
    `指向目录的符号链接展开之后不对：${tree.linkDir.join(' ')}`,
  )
  must(tree.emptyNote === '空目录', `空目录下面的说明不对：${tree.emptyNote}`)
  must(
    tree.hits[0] === 'file:lib/deep/nested/needle-file.ts' && tree.marked === 'needlefile',
    `找文件的结果不对：${tree.hits.join(' ')}（标出来的字：${tree.marked}）`,
  )
  must(
    tree.hitParentAsked === 0,
    '找之前 lib/deep 这一层已经被列过了：量不出结果是不是从整棵树里找的',
  )
  must(
    tree.hitOpened === 'lib/deep/nested/needle-file.ts' && tree.hitRevealed,
    `回车打开找到的文件、回到树上露出来：开的是 ${tree.hitOpened}，${tree.hitRevealed ? '露出来了' : '没露出来'}`,
  )
  must(
    lines.searchMs === null || tree.searchMs <= lines.searchMs,
    `找文件太慢：${ms(tree.searchMs)}，线是 ${lines.searchMs} ms`,
  )
  must(
    tree.outsideDots.startsWith('rejected：'),
    `用上一级目录绕到根外面的路径没有被拒：${tree.outsideDots}`,
  )
  must(tree.outsideFull.startsWith('rejected：'), `根外面的完整路径没有被拒：${tree.outsideFull}`)
  return failed
}

function judgeRealView(
  view: RealView,
  dirs: RealDirs,
  withCwd: boolean,
  lines: FileLines,
): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(
    view.firstLine === 'notes line 1' && view.lines >= 20,
    `文字文件读到的不对：第一行 ${JSON.stringify(view.firstLine)}，${view.lines} 行`,
  )
  must(view.paint !== 'pending', '文字文件的上色一直没有结果')
  must(view.viaFileLink === 'notes line 1', `经过指向文件的符号链接读到的不对：${view.viaFileLink}`)
  must(view.longMode === 'worker', `六千行的文件上色没有走工作线程：${view.longMode}`)
  must(view.longLines >= 6000, `六千行的文件行数不对：${view.longLines}`)
  must(view.longDom <= DOM_ROWS_MAX, `六千行的文件页面上画了 ${view.longDom} 行`)
  must(
    lines.shownMs === null || view.longShownMs <= lines.shownMs,
    `六千行的文件内容出来得太慢：${ms(view.longShownMs)}，线是 ${lines.shownMs} ms`,
  )
  must(
    lines.paintedMs === null || view.longPaintedMs <= lines.paintedMs,
    `六千行的文件上色太慢：${ms(view.longPaintedMs)}，线是 ${lines.paintedMs} ms`,
  )
  failed.push(...judgeGaps('打开六千行的文件、给它上色', view.longGaps, lines, false))
  must(
    view.holds.map((hold) => hold.split('｜').slice(0, 2).join('｜')).join(' ') ===
      'big.log｜tooLarge blob.dat｜binary shot.png｜binary',
    `显示不了的文件占位不对：${view.holds.join(' ／ ')}`,
  )
  const wanted = [
    'src/long.ts:4200→src/long.ts:4200',
    'notes.txt:12→notes.txt:12',
    'src/app.ts→src/app.ts',
  ]
  must(
    view.links.length === wanted.length && wanted.every((entry) => view.links.includes(entry)),
    `回答里认出来的文件不对：${view.links.join(' ／ ')}`,
  )
  must(
    view.plain.includes('../../outside/secret.txt') && view.plain.includes('console.log'),
    `项目外面的路径、不是文件的字被认成了文件，没认的只有：${view.plain.join(' ／ ')}`,
  )
  const wantText = ['value4200', 'notes line 12', 'export const app']
  view.jumps.forEach((jump, index) => {
    must(jump.inView && jump.marked, `${jump.label}：没有定位到那一行，或者标得不对`)
    must(
      jump.text.includes(wantText[index] ?? ''),
      `${jump.label}：那一行上写的不对：${JSON.stringify(jump.text.slice(0, 60))}`,
    )
    must(
      lines.jumpMs === null || jump.ms <= lines.jumpMs,
      `${jump.label}：点下去到定位好花了 ${ms(jump.ms)}，线是 ${lines.jumpMs} ms`,
    )
  })
  must(view.jumps.length === 3, `应该点开三个链接，点开了 ${view.jumps.length} 个`)
  if (withCwd) {
    must(
      view.cwdOpened === 'web/status.txt' && view.cwdText.startsWith('状态：正常'),
      `相对于会话工作目录写的文件名点开的不对：${view.cwdOpened}（${view.cwdText}）`,
    )
  }
  must(
    view.otherRoot === dirs.notes && view.otherRows > 0,
    `换到另一个目录的会话，面板没跟着换：${view.otherRoot}（${view.otherRows} 行），该是 ${dirs.notes}`,
  )
  must(view.backTabs === 0, `换回来之后开着的文件数变了：差 ${view.backTabs}`)
  return failed
}

export function judgeReal(
  seen: RealSeen,
  dirs: RealDirs,
  withCwd: boolean,
  lenient: boolean,
): string[] {
  const lines = lenient ? LENIENT_FILE_LINES : STRICT_FILE_LINES
  return [
    ...judgeRealTree(seen.tree, dirs, lines),
    ...judgeRealView(seen.view, dirs, withCwd, lines),
  ]
}
