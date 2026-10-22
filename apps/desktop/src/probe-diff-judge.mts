// 差异面板的验收量到的东西合不合格。示例仓库里有什么见 packages/core/src/mock/sample-repos.mts，
// 真的那两种的仓库是 scripts/check-diff.mjs 现建的（它开头写了里面有什么）。线划在哪、为什么，写在各条旁边。
import type { BasicsSeen, WritesSeen } from './probe-diff.mjs'
import type {
  LookSeen,
  ManySeen,
  NarrowSeen,
  NotesSeen,
  PlacesSeen,
  RoomySeen,
  TurnSeen,
} from './probe-diff-flow.mjs'
import type { RealManySeen, RealSeen } from './probe-diff-real.mjs'
import { longest, median, ms } from './probe-files-judge.mjs'

/**
 * 时间上的线。严的一套只在够快的机器上划（开发用的机器），都留了几倍的余量：
 * - 点开标签到概况和内容都到：模拟核心 2 秒，真的 6 秒（真的要起六七条 git，每条过一道连接）；
 * - 收起再展开几百个文件的目录、滚动、连着换文件的时候两帧之间最长 300 毫秒，滚动时帧间隔的中位数不过 34（三十帧）；
 * - 代理改完文件、回合结束之后面板跟上：从说话算起 60 秒（里面大半是回合自己的时间），不划更细的线，只报数。
 * 宽的一套给慢机器（流水线的虚拟机，或者 LITCH_CHECK_LENIENT=1）：这些只报数，只留“卡死了”的线：一帧 5 秒。
 */
interface DiffLines {
  openMs: number | null
  realOpenMs: number | null
  frameMaxMs: number
  frameMedianMs: number | null
}
const STRICT: DiffLines = { openMs: 2000, realOpenMs: 6000, frameMaxMs: 300, frameMedianMs: 34 }
const LENIENT: DiffLines = { openMs: null, realOpenMs: null, frameMaxMs: 5000, frameMedianMs: null }

/** 一段帧间隔合不合线。what：是做什么的时候量的 */
function judgeGaps(what: string, gaps: number[], lines: DiffLines, withMedian: boolean): string[] {
  const failed: string[] = []
  if (longest(gaps) > lines.frameMaxMs)
    failed.push(`${what}的时候卡了一下：最长一帧 ${ms(longest(gaps))}，线是 ${lines.frameMaxMs} ms`)
  if (withMedian && lines.frameMedianMs !== null && median(gaps) > lines.frameMedianMs)
    failed.push(
      `${what}的时候帧率掉了：帧间隔中位 ${median(gaps).toFixed(1)} ms，线是 ${lines.frameMedianMs} ms`,
    )
  return failed
}

/**
 * 打开面板为概况起几条命令：认仓库、状态、没跟踪文件的行数、改动的清单，一共四条，不随文件数变（规格 P3）。
 * 没跟踪的文件里有数不出行数的（空的，或者不是文字），再各问一次是不是二进制，最多问 24 个。
 * 内容另算：跟踪的文件合起来一条，没跟踪的文件一个一条。
 */
const SUMMARY_SPAWNS = 4
/** 一屏最多画这么多行树算正常（看得见的加上上下各多画的一截）。几百行都画出来就不对 */
const TREE_DOM_MAX = 120
/**
 * 加的行、删的行和面板底色之间至少要有这么大的亮度比，两种之间也要分得开；字在上面要读得清（4.5 是正文的线）。
 * 底色是很淡的一层，比值不会大：1.08 是人眼在大面积色块上分得出来的量级，实测六套都在 1.2 以上。
 */
const ROW_CONTRAST_MIN = 1.08
/**
 * 加的行和删的行两种底色（一绿一红）在红绿蓝上至少隔这么远。实测六套里最近的是“文艺”那一套（它的状态色本来就淡），
 * 27 上下；隔到 20 以下两种底色放在一起就不好分了
 */
const ROW_APART_MIN = 20
const INK_CONTRAST_MIN = 4.5

export interface MockSeen {
  basics: BasicsSeen
  writes: WritesSeen
  turn: TurnSeen
  notes: NotesSeen
  many: ManySeen
  places: PlacesSeen
  narrow: NarrowSeen
  /** 屏幕不够宽、窗口放不到那么宽的时候是 null：这一项没量 */
  roomy: RoomySeen | null
  look: LookSeen
}

export interface RealSeenAll {
  main: RealSeen
  many: RealManySeen
}

const spawnsOf = (asked: { spawns: number; byKind: Record<string, number> }): string =>
  `${asked.spawns} 条（${Object.entries(asked.byKind)
    .map(([kind, count]) => `${kind}×${count}`)
    .join('、')}）`

export function mockNumbers(seen: MockSeen): string {
  const { basics, many, turn } = seen
  return [
    `点开到 13 个文件的概况和内容都到 ${ms(basics.openMs)}，起了 ${spawnsOf(basics.asked)}`,
    `${many.entries} 个文件：树 ${many.treeRows} 行里画了 ${many.treeDrawn} 行；收起再展开三百个文件的目录 ${ms(many.fold.ms)}（最长一帧 ${ms(longest(many.fold.gaps))}）`,
    `滚树 帧间隔中位 ${median(many.scroll.gaps).toFixed(1)} ms、最长 ${ms(longest(many.scroll.gaps))}`,
    `连着换十个文件 ${ms(many.step.ms)}（最长一帧 ${ms(longest(many.step.gaps))}）`,
    `一个回合里重新取了 ${turn.refreshes} 次，面板收着的时候 ${turn.closed.refreshes} 次`,
    seen.roomy ? `宽窗口里面板 ${seen.roomy.side}px` : '屏幕不够宽，“文件那一栏在左边”没量',
  ].join('；')
}

function judgeBasics(basics: BasicsSeen, lines: DiffLines): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(basics.mode === 'together', `十几个文件应该是一起看的：${basics.mode}`)
  must(basics.entries === 13, `示例仓库里该有 13 个改了的文件：${basics.entries}`)
  must(basics.heads === 13, `内容区里该有 13 个文件头：${basics.heads}`)
  // 树上的一行：记号（改了 M、新加 A、删了 D、改名 R、没跟踪 U）、路径、增删行数
  for (const want of [
    'M Makefile +3−1',
    'M cmd/codex-harness-adapter/serve.go +2−3',
    'U cmd/codex-harness-adapter/serve_test.go +10',
    'A packages/core/src/index.mts +1',
    'R scripts/tool.py',
    'M scripts/build.sh',
  ]) {
    must(basics.tree.includes(want), `树上少了“${want}”：${basics.tree.join(' | ')}`)
  }
  must(
    basics.tree.some((row) => row.startsWith('D docs/')),
    `树上没有删了的那个文件：${basics.tree.join(' | ')}`,
  )
  must(/13/.test(basics.total), `顶上的合计里没有文件数：${basics.total}`)
  must(
    basics.asked.spawns <= SUMMARY_SPAWNS + 1 + 1 + 3,
    `打开面板起的命令多了：${spawnsOf(basics.asked)}，该不超过 ${SUMMARY_SPAWNS + 5} 条（概况 4、问一个没跟踪的文件是不是二进制 1、跟踪的内容 1、没跟踪的 3 个各 1）`,
  )
  must(basics.asked.refreshes === 1, `打开面板该只取一次概况：${basics.asked.refreshes}`)
  // 没有内容可画的：二进制两个、只改了名、只变了权限
  must(
    (basics.notes['docs/images/shot.png'] ?? '').includes('二进制'),
    `二进制文件没说是二进制：${basics.notes['docs/images/shot.png']}`,
  )
  must(
    (basics.notes['fixtures/blob.dat'] ?? '').includes('二进制'),
    `没跟踪的二进制文件没说是二进制：${basics.notes['fixtures/blob.dat']}`,
  )
  must(
    (basics.notes['scripts/tool.py'] ?? '').includes('重命名'),
    `只改了名的文件没说只改了名：${basics.notes['scripts/tool.py']}`,
  )
  must(
    (basics.notes['scripts/build.sh'] ?? '').includes('权限'),
    `只变了权限的文件没说只改了权限：${basics.notes['scripts/build.sh']}`,
  )
  must(basics.painted > 0, '差异没有上色')
  must(
    basics.atDefault.layout === 'unified' &&
      basics.atDefault.disabled &&
      basics.atDefault.stack === 'on',
    `面板是默认宽度（${basics.atDefault.width}px）的时候放不下并排，该自己合并着看、文件那一栏在上面、换视图的按钮停用：${JSON.stringify(basics.atDefault)}`,
  )
  must(
    basics.layouts.join(',') === 'split,unified',
    `面板拖宽（${basics.wideWidth}px）之后该是并排，点一下换成合并：${basics.layouts.join(',')}`,
  )
  must(basics.splitCells > 0, '并排的时候没有两栏的行')
  must(basics.splitWrap === 'on', '并排的时候该总是折行（不然右边那栏要横着滚才看得到）')
  must(basics.unifiedCells > 0, '合并的时候没有一栏的行')
  must(
    basics.inks.same !== '' && basics.inks.same === basics.inks.add,
    `没改的行和加的行，字该是同一种颜色（只有底色分加删）：没改的 ${basics.inks.same}，加的 ${basics.inks.add}`,
  )
  must(basics.inks.tokens >= 2, `上色的样式没生效：上了色的片段只有 ${basics.inks.tokens} 种颜色`)
  must(
    basics.filtered.length === 2 && basics.filtered.every((path) => path.includes('serve')),
    `筛“serve”该剩两个文件：${basics.filtered.join(' ')}`,
  )
  must(basics.filteredNone.length > 0, '筛不到的时候没有说明')
  must(
    basics.jump.current === 'cmd/codex-harness-adapter/serve_test.go' &&
      Math.abs(basics.jump.gap) <= 2,
    `点树上的文件没有跳到它：选中的是 ${basics.jump.current}，文件头离内容区顶 ${basics.jump.gap}px`,
  )
  must(
    basics.jump.last === 'scripts/tool.py',
    `点了最后一个文件（滚不到顶），选中的该还是它：${basics.jump.last}`,
  )
  must(
    basics.expand.gapsBefore > 0 &&
      basics.expand.rowsAfter > basics.expand.rowsBefore &&
      basics.expand.gapsAfter <= basics.expand.gapsBefore,
    `展开上下文之后行没有变多：${JSON.stringify(basics.expand)}`,
  )
  must(
    basics.scopes.all === 13 && basics.scopes.staged === 4 && basics.scopes.unstaged === 10,
    `三种范围的文件数不对（该是 13、4、10）：${JSON.stringify(basics.scopes)}`,
  )
  const acts = (name: string) => (basics.acts[name] ?? []).join(',')
  must(acts('plain') === 'stage,discard', `没暂存的文件头上该是暂存、还原：${acts('plain')}`)
  must(
    acts('staged') === 'unstage,discard',
    `暂存了的文件头上该是取消暂存、还原：${acts('staged')}`,
  )
  must(
    acts('half') === 'stage,unstage,discard',
    `暂存了一半的文件头上该是暂存、取消暂存、还原：${acts('half')}`,
  )
  must(acts('inStaged') === 'unstage', `“已暂存”里只该有取消暂存：${acts('inStaged')}`)
  must(acts('inUnstaged') === 'stage,discard', `“未暂存”里该是暂存、还原：${acts('inUnstaged')}`)
  if (lines.openMs !== null && basics.openMs > lines.openMs)
    failed.push(`点开差异标签到内容都到用了 ${ms(basics.openMs)}，线是 ${lines.openMs} ms`)
  return failed
}

/** 还原之前的那句话：点名是哪个文件、会丢什么、说找不回来；按钮上的字 */
function judgeAsk(what: string, ask: string[], path: string, loses: RegExp): string[] {
  const [title = '', note = ''] = ask
  const failed: string[] = []
  if (!title.includes(path)) failed.push(`${what}的确认框没点名是哪个文件：${title}`)
  if (!loses.test(note)) failed.push(`${what}的确认框没说清楚会丢什么：${note}`)
  return failed
}

function judgeWrites(writes: WritesSeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(
    writes.afterStage.join(',') === 'unstage,discard',
    `暂存之后文件头上该是取消暂存、还原：${writes.afterStage.join(',')}`,
  )
  must(
    writes.afterUnstage.join(',') === 'stage,discard',
    `取消暂存之后该回到暂存、还原：${writes.afterUnstage.join(',')}`,
  )
  failed.push(...judgeAsk('还原', writes.ask, 'Makefile', /3 行.*1 行.*无法撤销/))
  must(
    writes.ask.includes('还原') && writes.ask.includes('取消'),
    `还原的确认框上该有“还原”和“取消”两个按钮：${writes.ask.slice(2).join('、')}`,
  )
  must(writes.keptOnCancel, '点了取消，文件却没了')
  must(writes.goneOnYes, '确认还原之后文件还在列表里')
  failed.push(
    ...judgeAsk('删没跟踪的文件', writes.askUntracked, 'serve_test.go', /未跟踪.*10 行.*无法恢复/),
  )
  must(
    writes.askUntracked.includes('删除'),
    `没跟踪的文件，按钮上该写“删除”：${writes.askUntracked.slice(2).join('、')}`,
  )
  must(writes.untrackedGone, '确认删除之后没跟踪的文件还在列表里')
  must(
    /恢复/.test(writes.askDeleted[0] ?? '') && /不会丢失/.test(writes.askDeleted[1] ?? ''),
    `还原一个删了的文件，该说是拿回来、不会丢东西：${writes.askDeleted.slice(0, 2).join(' / ')}`,
  )
  must(writes.toasts.length === 0, `暂存、还原的过程中出了错：${writes.toasts.join(' | ')}`)
  must(writes.entries === 11, `还原了一个、删了一个之后该剩 11 个文件：${writes.entries}`)
  return failed
}

function judgeTurn(turn: TurnSeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(
    turn.afterTurn.moved &&
      turn.afterTurn.listed.includes('notes/agent-log.md') &&
      turn.afterTurn.listed.includes('notes/agent-1.md'),
    `代理改完文件、回合结束之后面板没有自己跟上：列表里代理写的文件是 ${turn.afterTurn.listed.join(' ') || '（没有）'}`,
  )
  // 回合结束取一次；仓库的元数据目录没动，监视不该再带来一次。留一次的余量给“回合结束”和监视撞在一起
  must(
    turn.refreshes >= 1 && turn.refreshes <= 2,
    `一个回合里重新取概况的次数不对：${turn.refreshes} 次（该是 1 次，最多 2 次）`,
  )
  must(
    turn.fromTranscript === 'notes/agent-1.md',
    `从对话里那条“改了文件”点过去，差异里选中的不是那个文件：${turn.fromTranscript}`,
  )
  must(
    turn.closed.refreshes === 0,
    `面板收着的时候不该去取差异：这期间取了 ${turn.closed.refreshes} 次`,
  )
  must(
    turn.closed.listed.includes('notes/agent-2.md'),
    `面板重新打开之后没有跟上收着的时候的改动：${turn.closed.listed.join(' ')}`,
  )
  must(
    /过长/.test(turn.tooLong.note) && turn.tooLong.picked === 'notes/agent-big-2.md',
    `对话里太长不展开的那一处，该有去差异面板的入口，点了之后选中那个文件：说的是“${turn.tooLong.note}”，选中的是 ${turn.tooLong.picked}`,
  )
  return failed
}

function judgeGone(turn: TurnSeen): string[] {
  return /没有未提交的改动/.test(turn.goneToast)
    ? []
    : [`从对话里点一个已经没有改动的文件，该说一声它现在没有改动：出的提示是“${turn.goneToast}”`]
}

function judgeNotes(notes: NotesSeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(notes.editor, '点了行号没有出写批注的框')
  must(
    /第 \d+–\d+ 行/.test(notes.rangeLabel),
    `按着 Shift 选了两行，框上没写是哪几行：${notes.rangeLabel}`,
  )
  must(notes.card.includes('这两行的文案再短一点'), `存下的批注不对：${notes.card}`)
  must(notes.chip.includes('1'), `输入区上没有“1 条批注”的牌子：${notes.chip}`)
  must(notes.kept, '换一个会话再回来，批注没了')
  must(
    notes.sent.includes('按批注改一下') &&
      notes.sent.includes('这两行的文案再短一点') &&
      notes.sent.includes('packages/ui/src/app/App.tsx'),
    `发出去的消息里没有带上批注（要有原话、批注和文件路径）：${notes.sent}`,
  )
  must(notes.cleared, '消息发出去之后批注没有清掉')
  return failed
}

function judgeMany(many: ManySeen, lines: DiffLines): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(many.entries === 420, `该有 420 个改了的文件：${many.entries}`)
  must(many.mode === 'single', `几百个文件应该一次看一个：${many.mode}`)
  must(many.heads === 1, `一次看一个文件的时候内容区里该只有一个文件头：${many.heads}`)
  must(many.treeRows > 420, `树上的行数不对（文件加目录该过 420）：${many.treeRows}`)
  must(
    many.treeDrawn > 0 && many.treeDrawn <= TREE_DOM_MAX,
    `树该只画看得见的那一段：${many.treeRows} 行里画了 ${many.treeDrawn} 行`,
  )
  must(many.fold.value === many.treeRows, '收起再展开之后树的行数对不上')
  must(many.lastShown, '滚到底看不到最后一个文件')
  must(
    /^11 \/ 420$/.test(many.step.value.trim()),
    `连着点十次“下一个文件”该到第 11 个：${many.step.value}`,
  )
  failed.push(...judgeGaps('收起再展开三百个文件的目录', many.fold.gaps, lines, false))
  failed.push(...judgeGaps('滚几百个文件的树', many.scroll.gaps, lines, true))
  failed.push(...judgeGaps('连着换文件', many.step.gaps, lines, false))
  return failed
}

function judgePlaces(places: PlacesSeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  const { huge, plain } = places
  must(
    /超过 8000 行/.test(huge.long) && huge.longRows === 0,
    `改了上万行的文件该只给摘要、不画内容：说明“${huge.long}”，画了 ${huge.longRows} 行`,
  )
  must(/超过 8000 行/.test(huge.log), `几万行的新文件该只给摘要：${huge.log}`)
  must(huge.minifiedCut, '单行几万字的文件，那一行没有截短')
  must(
    huge.wrap.off === 20 && huge.wrap.sideways && huge.wrap.on > huge.wrap.off,
    `折行开关不对：不折的时候长行该是一行高（20px）、内容区能横着滚，折了之后变高。量到 ${JSON.stringify(huge.wrap)}`,
  )
  must(/没有未提交的改动/.test(places.clean), `干净的仓库该说没有改动：${places.clean}`)
  must(/不是 git 仓库/.test(plain.before), `不是仓库的目录该说不是 git 仓库：${plain.before}`)
  must(
    plain.source === 'turn' && plain.files.length === 2,
    `不是仓库的目录里，回合改了文件之后该显示这一回合的改动（两个文件）：来源 ${plain.source}，${plain.files.join(' ')}`,
  )
  must(
    !plain.scopeShown && plain.acts === 0,
    `显示本回合改动的时候不该有范围和暂存、还原的按钮：范围 ${plain.scopeShown}，按钮 ${plain.acts} 个`,
  )
  must(/不是 git 仓库/.test(plain.banner), `显示本回合改动的时候没说明这不是仓库：${plain.banner}`)
  must(
    /不支持执行命令/.test(places.unsupported),
    `起不了进程的设备该说看不了：${places.unsupported}`,
  )
  must(/未连接/.test(places.offline), `没连上的设备该说没连上：${places.offline}`)
  return failed
}

function judgeNarrow(narrow: NarrowSeen): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(narrow.stacked === 'on' && narrow.treeAbove, '窗口最窄的时候文件那一栏没有挪到内容上面')
  must(
    narrow.layout === 'unified' && narrow.layoutDisabled,
    `窗口最窄的时候该只能合并着看：${narrow.layout}，按钮${narrow.layoutDisabled ? '已' : '没'}停用`,
  )
  must(narrow.paneHeight >= 120, `窗口最窄最矮的时候内容区被挤得太矮：${narrow.paneHeight}px`)
  return failed
}

function judgeRoomy(roomy: RoomySeen | null): string[] {
  if (!roomy) return []
  const ok = roomy.stacked === 'off' && roomy.treeLeft && roomy.layout === 'split'
  return ok
    ? []
    : [`面板够宽（${roomy.side}px）的时候文件那一栏该在左边、差异并排：${JSON.stringify(roomy)}`]
}

function judgeLook(look: LookSeen): string[] {
  const failed: string[] = []
  for (const item of look.looks) {
    if (item.add < ROW_CONTRAST_MIN || item.del < ROW_CONTRAST_MIN)
      failed.push(
        `${item.name}：加的行、删的行和底色分不开（${item.add}、${item.del}，至少 ${ROW_CONTRAST_MIN}）`,
      )
    if (item.between < ROW_APART_MIN)
      failed.push(
        `${item.name}：加的行和删的行两种底色太像（隔 ${item.between}，至少 ${ROW_APART_MIN}）`,
      )
    if (item.inkOnAdd < INK_CONTRAST_MIN || item.inkOnDel < INK_CONTRAST_MIN)
      failed.push(
        `${item.name}：字在加的行、删的行上读不清（${item.inkOnAdd}、${item.inkOnDel}，至少 ${INK_CONTRAST_MIN}）`,
      )
  }
  if (look.looks.length !== 6) failed.push(`该量六套外观：量了 ${look.looks.length} 套`)
  if (look.english[0] !== 'Diff' || look.english.some((word) => /[一-鿿]/.test(word)))
    failed.push(`换成英文之后还有中文：${look.english.join(' | ')}`)
  if (look.chinese[0] !== '差异') failed.push(`换回中文之后不对：${look.chinese.join(' | ')}`)
  return failed
}

export function judgeMock(seen: MockSeen, lenient: boolean): string[] {
  const lines = lenient ? LENIENT : STRICT
  return [
    ...judgeBasics(seen.basics, lines),
    ...judgeWrites(seen.writes),
    ...judgeTurn(seen.turn),
    ...judgeGone(seen.turn),
    ...judgeNotes(seen.notes),
    ...judgeMany(seen.many, lines),
    ...judgePlaces(seen.places),
    ...judgeNarrow(seen.narrow),
    ...judgeRoomy(seen.roomy),
    ...judgeLook(seen.look),
  ]
}

export function realNumbers(seen: RealSeenAll): string {
  const { main, many } = seen
  return [
    `点开到概况和内容都到 ${ms(main.openMs)}，起了 ${spawnsOf(main.asked)}`,
    `说“改个文件”到面板跟上 ${ms(main.turn.ms)}（这一回合重新取了 ${main.turn.refreshes} 次）`,
    `摆进 ${many.entries} 个文件之后 ${ms(many.arriveMs)} 看到（${many.byWatch ? '自己跟上的' : '点了重新取'}），这一版概况起了 ${many.spawns} 条命令`,
    `树 ${many.treeRows} 行里画了 ${many.treeDrawn} 行；收起再展开 ${ms(many.fold.ms)}（最长一帧 ${ms(longest(many.fold.gaps))}）；滚树 帧间隔中位 ${median(many.scroll.gaps).toFixed(1)} ms、最长 ${ms(longest(many.scroll.gaps))}；连着换六个文件 ${ms(many.step.ms)}（最长一帧 ${ms(longest(many.step.gaps))}）`,
  ].join('；')
}

export function judgeReal(
  seen: RealSeenAll,
  want: { appended: string; created: string; many: number },
  lenient: boolean,
): string[] {
  const lines = lenient ? LENIENT : STRICT
  const { main, many } = seen
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  must(main.mode === 'together', `几个文件应该是一起看的：${main.mode}`)
  must(/main/.test(main.branch), `没有认出分支：${main.branch}`)
  must(main.watching, '对面有 fs/watch，“重新取”上却说盯不了文件变化')
  // 仓库里摆的：改了的 src/app.ts、暂存了的 README.md、删了的 old.txt、改了名的 renamed.txt、二进制的 bin.dat、没跟踪的 fresh.txt
  for (const wantRow of [
    'M src/app.ts +2−2',
    'M README.md +1',
    'D old.txt −3',
    'R renamed.txt',
    'M bin.dat',
    'U fresh.txt +4',
  ]) {
    must(
      main.tree.some((row) => row.trim() === wantRow),
      `树上少了“${wantRow}”：${main.tree.join(' | ')}`,
    )
  }
  must(
    (main.notes['bin.dat'] ?? '').includes('二进制'),
    `二进制文件没说是二进制：${main.notes['bin.dat']}`,
  )
  must(
    (main.notes['renamed.txt'] ?? '').includes('重命名'),
    `只改了名的文件没说只改了名：${main.notes['renamed.txt']}`,
  )
  must(main.painted > 0, '差异没有上色')
  must(
    main.rows.add === 2 && main.rows.del === 2,
    `src/app.ts 该画出加的两行、删的两行：加 ${main.rows.add}，删 ${main.rows.del}`,
  )
  must(main.rows.after > main.rows.before, `展开上下文之后行没有变多：${JSON.stringify(main.rows)}`)
  must(
    main.scopes.all === 6 && main.scopes.staged === 2 && main.scopes.unstaged === 4,
    `三种范围的文件数不对（该是 6、2、4）：${JSON.stringify(main.scopes)}`,
  )
  must(
    main.asked.byKind.status === 1 && main.asked.spawns <= SUMMARY_SPAWNS + 1 + 1,
    `打开面板起的命令多了：${spawnsOf(main.asked)}，该不超过 ${SUMMARY_SPAWNS + 2} 条（概况 4、跟踪的内容 1、没跟踪的 1）`,
  )
  must(
    main.afterStage.join(',') === 'unstage,discard',
    `暂存之后文件头上该是取消暂存、还原：${main.afterStage.join(',')}`,
  )
  must(
    main.afterUnstage.join(',') === 'stage,discard',
    `取消暂存之后该回到暂存、还原：${main.afterUnstage.join(',')}`,
  )
  failed.push(...judgeAsk('还原', main.ask, 'src/app.ts', /2 行.*2 行.*无法撤销/))
  must(main.keptOnCancel, '点了取消，文件却没了')
  must(main.goneOnYes, '确认还原之后文件还在列表里')
  failed.push(
    ...judgeAsk('删没跟踪的文件', main.askUntracked, 'fresh.txt', /未跟踪.*4 行.*无法恢复/),
  )
  must(main.untrackedGone, '确认删除之后没跟踪的文件还在列表里')
  must(main.toasts.length === 0, `暂存、还原的过程中出了错：${main.toasts.join(' | ')}`)
  must(
    main.turn.moved &&
      main.turn.listed.includes(want.appended) &&
      main.turn.listed.includes(want.created),
    `代理改完文件、回合结束之后面板没有自己跟上：列表里有 ${main.turn.listed.join(' ') || '（都没有）'}，该有 ${want.appended} 和 ${want.created}`,
  )
  // 回合结束取一次；代理在根目录下新写了文件，监视可能再带来一两次
  must(
    main.turn.refreshes >= 1 && main.turn.refreshes <= 4,
    `一个回合里重新取概况的次数不对：${main.turn.refreshes} 次（该在 1 到 4 次之间）`,
  )
  must(/不是 git 仓库/.test(main.plain), `不是仓库的目录该说不是 git 仓库：${main.plain}`)

  must(many.entries >= want.many, `摆进去 ${want.many} 个文件，列表里只有 ${many.entries} 个`)
  must(many.mode === 'single', `几百个文件应该一次看一个：${many.mode}`)
  must(
    many.treeDrawn > 0 && many.treeDrawn <= TREE_DOM_MAX,
    `树该只画看得见的那一段：${many.treeRows} 行里画了 ${many.treeDrawn} 行`,
  )
  // 概况要的命令条数不随文件数变；这一段里可能取了不止一次（摆文件的途中监视就报了），所以按取的次数放宽
  must(
    many.spawns > 0 && many.spawns <= SUMMARY_SPAWNS * 4 + 8,
    `几百个文件的概况起的命令多了：${many.spawns} 条`,
  )
  failed.push(...judgeGaps('收起再展开几百个文件的目录', many.fold.gaps, lines, false))
  failed.push(...judgeGaps('滚几百个文件的树', many.scroll.gaps, lines, true))
  failed.push(...judgeGaps('连着换文件', many.step.gaps, lines, false))
  if (lines.realOpenMs !== null && main.openMs > lines.realOpenMs)
    failed.push(`点开差异标签到内容都到用了 ${ms(main.openMs)}，线是 ${lines.realOpenMs} ms`)
  return failed
}
