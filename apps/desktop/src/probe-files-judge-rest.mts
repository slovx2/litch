// 文件面板的验收（模拟核心那一种）量到的东西合不合格：菜单与加入对话、对话里的路径、换地方与降级、外观、
// 面板这个框（宽窄窗口、快捷键、应用菜单、重开之后）。另一半在 probe-files-judge.mts。
import type { TreeSeen } from './probe-files.mjs'
import type { FrameSeen, KeysSeen, ReloadSeen } from './probe-files-frame.mjs'
import {
  type FileLines,
  judgeSearch,
  judgeTree,
  judgeView,
  LENIENT_FILE_LINES,
  longest,
  median,
  ms,
  STRICT_FILE_LINES,
} from './probe-files-judge.mjs'
import type { LinksSeen, MenuSeen } from './probe-files-links.mjs'
import type { LookSeen, PlacesSeen } from './probe-files-places.mjs'
import type { NewPageSeen, RoomSeen } from './probe-files-room.mjs'
import type { SearchSeen, ViewSeen } from './probe-files-view.mjs'
import type { SizeSeen } from './probe-terminal-size.mjs'

export interface ShellSeen {
  /** 窗口是默认大小、缩到最窄最矮、中等宽、再放回去，面板各画多宽 */
  wide: FrameSeen
  narrow: FrameSeen
  /** 最窄最矮的窗口里，面板开着的时候输入框和请求卡片摆得对不对 */
  room: RoomSeen
  middle: FrameSeen
  restored: FrameSeen
  /** 新建对话页上面板跟着页上选的设备和项目走 */
  newPage: NewPageSeen
  /** 开着终端面板：侧面板开着、收起、再打开，终端里的程序看到的行列数和屏幕上的 */
  term: { withSide: SizeSeen; withoutSide: SizeSeen; again: SizeSeen }
  /** 窗口允许的最窄宽度 */
  minWidth: number
  /** 应用菜单里有没有“侧面板”这一项；点一下收起、再点一下打开 */
  menuFound: boolean
  menuClosed: boolean
  menuOpened: boolean
  keys: KeysSeen
  /** 重启核心之前面板多宽 */
  widthBefore: number
  reload: ReloadSeen
}

export interface MockSeen {
  tree: TreeSeen
  view: ViewSeen
  search: SearchSeen
  menu: MenuSeen
  links: LinksSeen
  places: PlacesSeen
  look: LookSeen
  shell: ShellSeen
}

function judgeMenu(menu: MenuSeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(
    menu.items.join(',') === 'mention,copyRelative,copyFull',
    `右键菜单里的项不对：${menu.items.join(',')}（${menu.labels.join('、')}）`,
  )
  must(menu.selectedOnContext, '点了右键的那一行没有成为选中的')
  must(menu.focusFirst && menu.arrowMoved, '菜单出来时焦点不在第一项上，或者上下键走不动')
  must(menu.escClosed && menu.escRefocused, '按 Esc 没有收起菜单，或者焦点没有回到树上')
  must(menu.outsideClosed, '点到菜单外面，菜单没有收起')
  must(menu.keyboardMenu, '键盘上叫不出菜单（Shift+F10）')
  must(
    menu.copiedRelative === 'Makefile' && menu.copiedFull === '~/work/litch/Makefile',
    `复制的路径不对：相对 ${menu.copiedRelative}，完整 ${menu.copiedFull}`,
  )
  must(menu.copyToast.includes('Makefile'), `复制之后没有提示：${menu.copyToast}`)
  must(
    menu.mentioned === 'Makefile' && menu.mentionFocus,
    `“加入对话”之后带着的片是 ${JSON.stringify(menu.mentioned)}，焦点${menu.mentionFocus ? '在' : '不在'}输入框里`,
  )
  must(
    menu.mentionTyped === '先写的字',
    `“加入对话”动了输入框里已经写的字：${JSON.stringify(menu.mentionTyped)}`,
  )
  must(
    menu.mentionPath.endsWith(' Makefile'),
    `那一片指的路径不是相对工作目录的：${JSON.stringify(menu.mentionPath)}`,
  )
  must(
    menu.dirMentioned === 'Makefile,docs/',
    `再加一个目录，带着的片是 ${JSON.stringify(menu.dirMentioned)}`,
  )
  must(
    menu.headMentioned === 'Makefile,docs/,package.json',
    `查看器标题栏上的“加入对话”：带着的片是 ${JSON.stringify(menu.headMentioned)}`,
  )
  must(
    menu.againMentioned === menu.headMentioned,
    `同一个文件加了两遍：${JSON.stringify(menu.againMentioned)}`,
  )
  return failed
}

function judgeLinks(links: LinksSeen, lines: FileLines): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  const wanted = [
    'cmd/codex-harness-adapter/serve.go:131→cmd/codex-harness-adapter/serve.go:131',
    '使用说明→docs/guide.md:12',
    'README.md→README.md',
    'packages/core/src/device/files.mts:40→packages/core/src/device/files.mts:40',
    'packages/ui/src/app/App.tsx→packages/ui/src/app/App.tsx',
    'fixtures/long.ts:4200→fixtures/long.ts:4200',
  ]
  must(
    links.links.length === wanted.length && wanted.every((entry) => links.links.includes(entry)),
    `回答里认出来的文件不对：${links.links.join(' ／ ')}`,
  )
  must(
    ['console.log', '../outside/secret.txt'].every((entry) => links.plain.includes(entry)),
    `不是项目里的文件的也被认成了文件，没认的只有：${links.plain.join(' ／ ')}`,
  )
  must(links.panelOpened, '面板收着的时候点对话里的路径，面板没有自己打开到“文件”标签')
  const wantJumps = [
    'cmd/codex-harness-adapter/serve.go:131',
    'fixtures/long.ts:4200',
    'docs/guide.md:12',
    'README.md',
  ]
  wantJumps.forEach((want, index) => {
    const jump = links.jumps[index]
    const got = jump ? `${jump.file}${jump.line === null ? '' : `:${jump.line}`}` : '（没点成）'
    must(got === want, `点第 ${index + 1} 个链接开的不对：${got}，该是 ${want}`)
    if (!jump) return
    must(jump.preview, `从对话里点开的 ${jump.file} 应该是预览`)
    must(jump.inView && jump.marked, `${jump.label}：没有定位到那一行，或者那一行没标出来`)
    must(jump.selected, `${jump.label}：树里没有把它露出来、选中`)
    must(
      lines.jumpMs === null || jump.ms <= lines.jumpMs,
      `${jump.label}：点下去到定位好花了 ${ms(jump.ms)}，线是 ${lines.jumpMs} ms`,
    )
  })
  must(links.again, '滚走之后同一个链接再点一次，没有回到那一行')
  must(
    links.toolLinks.length >= 2 && links.toolOpened === 'cmd/codex-harness-adapter/serve_test.go',
    `文件改动详情里的路径点不开：${links.toolLinks.join(' ／ ')}，开的是 ${links.toolOpened}`,
  )
  return failed
}

function judgePlaces(places: PlacesSeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(places.home === 'local/litch｜~/work/litch', `起头的会话，面板挂的地方不对：${places.home}`)
  must(
    places.other === 'local/docs｜~/work/docs-site',
    `换到另一个项目的会话，面板没跟着换：${places.other}`,
  )
  must(
    places.otherFresh === '没展开｜没开文件｜滚到 0',
    `另一个项目的树带着别处的状态：${places.otherFresh}`,
  )
  const { kept } = places
  must(
    kept.rows === kept.rowsBefore && Math.abs(kept.scroll - kept.scrollBefore) <= 2,
    `换回来之后树的状态没留住：行数 ${kept.rows}（原来 ${kept.rowsBefore}），滚到 ${kept.scroll}（原来 ${kept.scrollBefore}）`,
  )
  must(
    kept.tabs === kept.tabsBefore,
    `换回来之后开着的文件变了：${kept.tabs}（原来 ${kept.tabsBefore}）`,
  )
  must(places.keptSelected, '换回来之后选中的那一行没留住')
  must(
    places.loose === 'local/｜/Users/dev/notes/launchd' && places.looseRows > 0,
    `不属于项目的会话，根应该是它的工作目录：${places.loose}（${places.looseRows} 行）`,
  )
  must(
    places.unsupported.startsWith('unsupported｜此设备不支持查看文件｜') &&
      !places.unsupportedRetry,
    `不提供文件访问的设备，说明不对：${places.unsupported}`,
  )
  must(
    places.noSearchRows > 0 && places.noSearch.startsWith('unsupported｜此设备不支持搜索文件｜'),
    `不提供找文件的设备：树 ${places.noSearchRows} 行，找文件那里写的是 ${places.noSearch}`,
  )
  must(
    places.offline.startsWith('offline｜') && places.offlineRefresh,
    `没连上的设备，说明不对或者刷新还按得了：${places.offline}`,
  )
  must(places.hiddenOnPage, '开着“设备”页的时候侧面板还显示着')
  must(places.backFromPage, '从“设备”页回到会话，侧面板没有原样回来')
  return failed
}

function judgeLook(look: LookSeen): string[] {
  const failed: string[] = []
  if (look.looks.length !== 6) failed.push(`应该量六套外观，量到 ${look.looks.length} 套`)
  for (const entry of look.looks) {
    const [name, panel, wantPanel, sel, wantSel, font, wantFont, rowHeight, lineHeight, clear] =
      entry.split('｜')
    if (panel !== wantPanel || sel !== wantSel)
      failed.push(
        `${name}：面板的颜色没跟着皮肤走（底 ${panel}，要 ${wantPanel}；选中 ${sel}，要 ${wantSel}）`,
      )
    if (font !== wantFont) failed.push(`${name}：代码的字体是 ${font}，皮肤要的是 ${wantFont}`)
    // 行高是算“只画看得见的那些行”用的数，哪套皮肤都不能改
    if (rowHeight !== '24' || lineHeight !== '20')
      failed.push(`${name}：行高变了（树 ${rowHeight}，代码 ${lineHeight}），该是 24 和 20`)
    if (clear !== '看得清') failed.push(`${name}：${clear}`)
  }
  const light = new Set(
    look.looks.filter((entry) => entry.includes('/light')).map((entry) => entry.split('｜')[1]),
  )
  const dark = new Set(
    look.looks.filter((entry) => entry.includes('/dark')).map((entry) => entry.split('｜')[1]),
  )
  if ([...light].some((color) => dark.has(color))) failed.push('明暗两种模式下面板的底色一样')
  const english = [
    'Side panel',
    'Files',
    'Side panel (⌘/Ctrl+Alt+B)',
    'Find a file',
    'File tree',
    'Read-only',
  ]
  const chinese = ['侧面板', '文件', '侧面板（⌘/Ctrl+Alt+B）', '查找文件', '文件树', '只读']
  if (look.english.join('|') !== english.join('|'))
    failed.push(`英文界面下的文案不对：${look.english.join('|')}`)
  if (look.chinese.join('|') !== chinese.join('|'))
    failed.push(`换回中文之后的文案不对：${look.chinese.join('|')}`)
  return failed
}

function judgeShell(shell: ShellSeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  const say = (seen: FrameSeen) =>
    `${seen.mode}，面板 ${seen.side}，对话 ${seen.main}，窗口 ${seen.inner}`
  const { wide, narrow, middle, restored, room, newPage, term } = shell
  // 窗口够宽：对话至少留 380、面板至少 360（界面里的 MAIN_MIN、SIDE_MIN），左右各是树和内容
  must(
    wide.open && wide.mode === 'docked' && wide.main >= 380 && wide.side >= 360 && !wide.stacked,
    `默认大小的窗口里面板应该和对话并排、树和内容左右摆：${say(wide)}`,
  )
  // 窗口最窄：两边一起让，对话 320、面板 280（MAIN_FLOOR、SIDE_FLOOR），还是并排，不压到对话上
  must(
    narrow.open && narrow.mode === 'tight' && narrow.main >= 320 && narrow.side >= 280,
    `最窄的窗口（${shell.minWidth}）里面板和对话应该各让一些、还是并排：${say(narrow)}`,
  )
  for (const [name, seen] of [
    ['默认大小', wide],
    ['最窄', narrow],
    ['中等宽', middle],
  ] as const) {
    must(
      seen.gap >= 0 && seen.overflow === 0 && seen.main + seen.side + seen.sidebar === seen.inner,
      `${name}的窗口里面板没有和对话并排摆好：${say(seen)}，离对话 ${seen.gap}，伸出窗口 ${seen.overflow}`,
    )
  }
  must(narrow.stacked, '面板窄的时候文件标签应该改成树在上、内容在下')
  must(
    room.faults === '' && room.cardHeight >= 80 && room.inputHeight > 0,
    `最窄最矮的窗口里开着面板，请求卡片和输入框没摆好：${room.faults || '没有岔子'}（卡片高 ${room.cardHeight}，输入框高 ${room.inputHeight}，面板 ${room.side}，对话 ${room.main}）`,
  )
  must(
    room.newPageFaults === '',
    `最窄最矮的窗口里开着面板，新建对话页的输入框没摆好：${room.newPageFaults}`,
  )
  must(
    middle.mode === 'docked' && middle.main >= 380 && middle.side >= 360 && middle.side < wide.side,
    `中等宽的窗口里面板应该自己让窄一点：${say(middle)}`,
  )
  must(
    restored.mode === wide.mode && restored.side === wide.side,
    `窗口放回原来的大小，面板没有回到原来的宽度：${say(restored)}（原来 ${say(wide)}）`,
  )
  // 让位只是画得窄，记下来的宽度不改（记录里还有各会话开没开面板，中间开过面板的会话会变，不比）
  const widthOf = (saved: string) => (JSON.parse(saved || '{}') as { width?: number }).width
  must(
    widthOf(wide.saved) === widthOf(narrow.saved) &&
      widthOf(wide.saved) === widthOf(restored.saved),
    `窗口变窄的时候记下来的宽度被改了：${narrow.saved}、${restored.saved}（原来 ${wide.saved}）`,
  )
  // ---- 新建对话页 ----
  must(
    newPage.start === 'local/litch｜~/work/litch' && newPage.startRows > 0,
    `到新建对话页，面板没有挂在要建的那个项目上：${newPage.start}`,
  )
  must(
    newPage.workspace === 'local/docs｜~/work/docs-site',
    `在新建对话页上换了项目，面板没跟着换：${newPage.workspace}`,
  )
  must(
    newPage.noWorkspace.startsWith('没有项目目录'),
    `新建对话页上选了“无项目”，面板里没有说明：${newPage.noWorkspace}`,
  )
  must(
    newPage.device === 'build/infra｜/srv/work/infra',
    `在新建对话页上换了设备和项目，面板没跟着换：${newPage.device}`,
  )
  // ---- 终端的行列数 ----
  for (const [name, size] of [
    ['侧面板开着', term.withSide],
    ['侧面板收起', term.withoutSide],
    ['侧面板再打开', term.again],
  ] as const) {
    must(
      size.told === `${size.rows} ${size.cols}`,
      `${name}：终端里的程序看到的是 ${size.told}，屏幕上是 ${size.rows} 行 ${size.cols} 列`,
    )
  }
  must(
    term.withoutSide.cols > term.withSide.cols && term.again.cols === term.withSide.cols,
    `侧面板一开一合，终端的列数没有跟着变：${term.withSide.cols} → ${term.withoutSide.cols} → ${term.again.cols}`,
  )
  must(shell.menuFound, '应用菜单里没有“侧面板”这一项')
  must(shell.menuClosed && shell.menuOpened, '点应用菜单里的“侧面板”，面板没有跟着开合')
  const { keys } = shell
  must(keys.closed && keys.reopened, '按 Cmd/Ctrl+Alt+B 开合不了侧面板')
  must(keys.fromComposer, '焦点在输入框里的时候，快捷键不管用')
  must(keys.focusInside, '用快捷键打开面板之后，焦点没有进到面板里')
  must(keys.hidByButton, '标签栏上的收起按钮不管用')
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0] = keys.widths
  must(
    w1 === w0 + 24 &&
      w2 === w0 + 48 &&
      w3 === w0 + 72 &&
      w4 === w0 + 48 &&
      w5 === w0 + 24 &&
      w6 === w0,
    `用方向键调面板的宽度不对：${keys.widths.join(' → ')}`,
  )
  must(keys.savedWidth === w6, `调完的宽度没有记下来：记的是 ${keys.savedWidth}，画的是 ${w6}`)
  const [t0 = 0, t1 = 0, t2 = 0, t3 = 0, t4 = 0] = keys.treeWidths
  must(
    t1 === t0 + 16 && t2 === t0 + 32 && t3 === t0 + 16 && t4 === t0,
    `用方向键调树的宽度不对：${keys.treeWidths.join(' → ')}`,
  )
  const [d0 = 0, d1 = 0, d2 = 0] = keys.dragged
  must(d1 === d0 + 48 && d2 === d0, `拖面板左边那条调宽度不对：${keys.dragged.join(' → ')}`)
  const [e0 = 0, e1 = 0, e2 = 0] = keys.treeDragged
  must(
    e1 === e0 + 32 && e2 === e0,
    `拖树和内容之间那一条调宽度不对：${keys.treeDragged.join(' → ')}`,
  )
  const { reload } = shell
  must(
    reload.openAtStart && reload.widthAtStart === shell.widthBefore,
    `重新打开之后面板没有照上次的样子开着：${reload.openAtStart ? '开着' : '收着'}，宽 ${reload.widthAtStart}（上次 ${shell.widthBefore}）`,
  )
  must(!reload.stoleFocus, '启动时面板本来就开着，它不该抢焦点')
  must(
    reload.rows > 0 && reload.rows < 100 && reload.tabs === 0,
    `重新打开之后树应该从根开始、没有开着的文件：${reload.rows} 行，${reload.tabs} 个文件`,
  )
  return failed
}

export function mockNumbers(seen: MockSeen): string {
  const { many, scroll } = seen.tree
  const { long } = seen.view
  return [
    `展开三万个条目的目录 ${ms(many.ms)}（最长一帧 ${ms(longest(many.gaps))}，${many.rows} 行里画了 ${many.dom} 行，这一层问了 ${many.asked} 次）`,
    `在里面滚动 帧间隔中位 ${median(scroll.gaps).toFixed(1)} ms、最长 ${ms(longest(scroll.gaps))}（${scroll.gaps.length} 帧）`,
    `六千行的文件 内容 ${ms(long.shownMs)}、上色 ${ms(long.paintedMs)}（${long.mode}），这期间最长一帧 ${ms(longest(long.gaps))}，滚动最长一帧 ${ms(longest(long.rollGaps))}`,
    `点对话里的链接到定位好 最长 ${ms(longest(seen.links.jumps.map((jump) => jump.ms)))}`,
  ].join('；')
}

export function judgeMock(seen: MockSeen, lenient: boolean): string[] {
  const lines = lenient ? LENIENT_FILE_LINES : STRICT_FILE_LINES
  return [
    ...judgeTree(seen.tree, lines),
    ...judgeView(seen.view, lines),
    ...judgeSearch(seen.search),
    ...judgeMenu(seen.menu),
    ...judgeLinks(seen.links, lines),
    ...judgePlaces(seen.places),
    ...judgeLook(seen.look),
    ...judgeShell(seen.shell),
  ]
}
