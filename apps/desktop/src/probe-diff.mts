// 差异面板的验收，对着模拟核心（示例仓库见 packages/core/src/mock/sample-repos.mts）：
// 概况和内容、两种视图、折行、筛文件、点文件跳过去、展开上下文、上色、三种范围、暂存和还原（还原先问）。
// 接着的几组在 probe-diff-flow.mts。这些函数被原样送进页面里执行，不能引用函数外面的东西。
import type { Asked, DiffKit } from './probe-diff-kit.mjs'
import type { FilesKit } from './probe-files-kit.mjs'

export interface BasicsSeen {
  /** 从点开标签到概况和内容都到，毫秒 */
  openMs: number
  /** 这期间核心为它向设备起了几条命令 */
  asked: Asked
  mode: string
  entries: number
  /** 树上的文件：记号 路径 增删行数 */
  tree: string[]
  heads: number
  total: string
  /** 没有内容可画的那几个文件各说了什么 */
  notes: Record<string, string>
  /** 上了色的片段有几个（上色在工作线程里做，这里只有工作线程一条路） */
  painted: number
  /** 面板是默认宽度的时候（放不下并排）：多宽、是哪种视图、换视图的按钮是不是停用的、文件那一栏是不是在上面 */
  atDefault: { width: number; layout: string; disabled: boolean; stack: string }
  /** 把面板拖宽之后多宽；这时是并排还是合并；点一下之后；并排时一行有两栏代码 */
  wideWidth: number
  layouts: string[]
  /** 并排的时候折不折行（总是折） */
  splitWrap: string
  splitCells: number
  unifiedCells: number
  /**
   * 字的颜色（合并着看的时候量）：没改的行、加的行各是什么颜色（该一样，都是正文的颜色，底色才分加删）；
   * 上了色的片段一共有几种颜色（只有一种就是上色的样式没生效）
   */
  inks: { same: string; add: string; tokens: number }
  /** 筛“serve”剩下哪些文件；筛一个没有的 */
  filtered: string[]
  filteredNone: string
  /**
   * 点树上的一个文件：内容区滚到它的文件头（文件头顶到内容区顶的距离，像素），树上它成了选中的；
   * 点最后一个文件（它滚不到顶）：选中的还是它
   */
  jump: { gap: number; current: string; last: string }
  /** 展开上下文：点之前、点之后各有几行、几个“还有没显示的” */
  expand: { rowsBefore: number; rowsAfter: number; gapsBefore: number; gapsAfter: number }
  /** 三种范围各几个文件 */
  scopes: Record<string, number>
  /** 文件头上的按钮：全部里一个没暂存的、一个暂存了的、暂存了一半的；已暂存里的；没暂存里的 */
  acts: Record<string, string[]>
}

export async function mockBasics(session: string): Promise<BasicsSeen> {
  const store = window as unknown as { __filesKit: FilesKit; __diffKit: DiffKit }
  const kit = store.__filesKit
  const diff = store.__diffKit
  const { one, all, until, text, frame } = kit
  await kit.openSession(session)
  const started = performance.now()
  await diff.open()
  const box = await diff.settled()
  const openMs = Math.round(performance.now() - started)
  const asked = await diff.asked()
  const tree = await diff.listed()
  const serve = 'cmd/codex-harness-adapter/serve.go'

  await until('上色到了', () => all('.dp [class^="hljs-"]').length > 0, 20_000)
  const painted = all('.dp [class^="hljs-"]').length
  const notes: Record<string, string> = {}
  for (const note of all('.dp-note')) notes[note.dataset.path ?? ''] = text(note)

  // 两种视图。面板默认的宽度放不下并排：自己合并着看；拖宽了才并排
  const pane = () => diff.pane() as HTMLElement
  const atDefault = {
    width: kit.side()?.offsetWidth ?? 0,
    layout: pane().dataset.layout ?? '',
    disabled: one<HTMLButtonElement>('.db [data-tool="layout"]')?.disabled === true,
    stack: box.dataset.stack ?? '',
  }
  const wideWidth = await diff.resize(660)
  await until('拖宽之后并排', () => pane().dataset.layout === 'split', 5000).catch(() => null)
  const layouts = [pane().dataset.layout ?? '']
  const splitWrap = pane().dataset.wrap ?? ''
  const splitCells = all('.dr.two', pane()).length
  diff.tool('layout')
  await until('换成合并', () => pane().dataset.layout === 'unified')
  layouts.push(pane().dataset.layout ?? '')
  const unifiedCells = all('.dr.one', pane()).length
  const inkOf = (element: Element | null) => (element ? getComputedStyle(element).color : '')
  const inks = {
    same: inkOf(one('.dr.one.same .dc', pane())),
    add: inkOf(one('.dr.one.add .dc', pane())),
    tokens: new Set(all('[class^="hljs-"]', pane()).map(inkOf)).size,
  }

  diff.tool('layout')
  await until('换回并排', () => pane().dataset.layout === 'split')

  // 筛文件
  await diff.filter('serve')
  const filtered = diff.files().map((file) => file.path)
  await diff.filter('没有这个文件')
  const filteredNone = text(one('.dt-none'))
  await diff.filter('')

  // 点树上的文件：跳过去
  const target = 'cmd/codex-harness-adapter/serve_test.go'
  const currentRows = () =>
    all('.dt-row[aria-current="true"]')
      .map((item) => item.dataset.path ?? '')
      .join(',')
  const row = await until('树上的 serve_test.go', () => diff.treeRow(target))
  row.click()
  await until('serve_test.go 成了选中的', () => currentRows() === target)
  await frame()
  await frame()
  const anchor = all('.dp-anchor').find((item) => item.dataset.path === target)
  // 按屏幕上的位置量：offsetTop 是到侧面板顶的距离，拿它和滚动位置比，跳偏了也量不出来
  const gap = anchor
    ? Math.round(anchor.getBoundingClientRect().top - pane().getBoundingClientRect().top)
    : -1
  const current = currentRows()
  const lastFile = 'scripts/tool.py'
  diff.treeRow(lastFile)?.click()
  await kit.sleep(400)
  const jump = { gap, current, last: currentRows() }

  // 展开上下文
  diff.treeRow(serve)?.click()
  await until('serve.go 的行画出来', () => diff.rows(serve).length > 0)
  const gaps = () => diff.rows(serve).filter((item) => item.classList.contains('gap')).length
  const rowsBefore = diff.rows(serve).length
  const gapsBefore = gaps()
  const more = await until('“展开”的按钮', () =>
    diff
      .rows(serve)
      .map((item) => one<HTMLButtonElement>('button.dr-more', item))
      .find(Boolean),
  )
  more.click()
  await until('展开之后行多了', () => diff.rows(serve).length > rowsBefore, 20_000)
  const expand = { rowsBefore, rowsAfter: diff.rows(serve).length, gapsBefore, gapsAfter: gaps() }

  // 三种范围，和各自文件头上的按钮
  const acts: Record<string, string[]> = {
    plain: diff.acts('Makefile'),
    staged: diff.acts('packages/ui/src/app/App.tsx'),
    half: diff.acts('packages/core/src/device/files.mts'),
  }
  const scopes: Record<string, number> = { all: diff.count() }
  await diff.scope('staged')
  await diff.settled()
  scopes.staged = diff.count()
  acts.inStaged = diff.acts('packages/ui/src/app/App.tsx')
  await diff.scope('unstaged')
  await diff.settled()
  scopes.unstaged = diff.count()
  acts.inUnstaged = diff.acts('Makefile')
  await diff.scope('all')
  await diff.settled()

  return {
    openMs,
    asked,
    mode: box.dataset.mode ?? '',
    entries: Number(box.dataset.entries),
    tree,
    heads: all('.dp-head').length,
    total: text(one('.db-total')),
    notes,
    painted,
    atDefault,
    wideWidth,
    layouts,
    splitWrap,
    splitCells,
    unifiedCells,
    inks,
    filtered,
    filteredNone,
    jump,
    expand,
    scopes,
    acts,
  }
}

export interface WritesSeen {
  /** 暂存之后文件头上的按钮；取消暂存之后的 */
  afterStage: string[]
  afterUnstage: string[]
  /** 点了还原：确认框的标题、说明、两个按钮上的字 */
  ask: string[]
  /** 点了取消：文件还在 */
  keptOnCancel: boolean
  /** 确认之后：文件从列表里没了 */
  goneOnYes: boolean
  /** 没跟踪的文件：确认框上的说明；确认之后没了 */
  askUntracked: string[]
  untrackedGone: boolean
  /** 删了的文件：确认框上的说明（说不会丢东西） */
  askDeleted: string[]
  /** 做这几件事的过程中出过的出错提示 */
  toasts: string[]
  entries: number
}

export async function mockWrites(): Promise<WritesSeen> {
  const store = window as unknown as { __filesKit: FilesKit; __diffKit: DiffKit }
  const kit = store.__filesKit
  const diff = store.__diffKit
  const { one, all, until, text } = kit
  const toasts: string[] = []
  const noteToast = () => {
    const shown = kit.toast('diff-act')
    if (shown) toasts.push(shown)
  }
  const file = 'Makefile'
  const fresh = 'cmd/codex-harness-adapter/serve_test.go'
  const gone =
    (await diff.paths()).find(
      (path) => path.startsWith('docs/') && path.endsWith('.md') && path !== 'docs/guide.md',
    ) ?? ''
  const listed = async (path: string) => (await diff.paths()).includes(path)
  const dialog = () => one<HTMLDialogElement>('dialog.confirm')
  const askOf = () => {
    const element = dialog()
    return element
      ? [
          text(one('b', element)),
          text(one('.confirm-body > span', element)),
          ...all('button', element).map((button) => text(button)),
        ]
      : []
  }

  let before = diff.version()
  diff.act(file, 'stage')
  await diff.settled(before)
  const afterStage = diff.acts(file)
  before = diff.version()
  diff.act(file, 'unstage')
  await diff.settled(before)
  const afterUnstage = diff.acts(file)
  noteToast()

  // 还原：先问。取消了什么都不动
  diff.act(file, 'discard')
  await until('还原的确认框', dialog)
  const ask = askOf()
  one<HTMLButtonElement>('.btn.ghost', dialog())?.click()
  await until('确认框关了', () => !dialog())
  await kit.sleep(300)
  const keptOnCancel = await listed(file)
  before = diff.version()
  diff.act(file, 'discard')
  await until('还原的确认框', dialog)
  one<HTMLButtonElement>('.confirm-yes', dialog())?.click()
  await diff.settled(before)
  const goneOnYes = !(await listed(file))
  noteToast()

  // 没跟踪的文件：说清楚是删文件
  diff.act(fresh, 'discard')
  await until('删除的确认框', dialog)
  const askUntracked = askOf()
  before = diff.version()
  one<HTMLButtonElement>('.confirm-yes', dialog())?.click()
  await diff.settled(before)
  const untrackedGone = !(await listed(fresh))
  noteToast()

  // 删了的文件：还原是拿回来，不丢东西。只看说明，不做
  diff.treeRow(gone)?.click()
  await until('删了的那个文件的文件头', () => diff.head(gone))
  diff.act(gone, 'discard')
  await until('拿回来的确认框', dialog)
  const askDeleted = askOf()
  one<HTMLButtonElement>('.btn.ghost', dialog())?.click()
  await until('确认框关了', () => !dialog())

  return {
    afterStage,
    afterUnstage,
    ask,
    keptOnCancel,
    goneOnYes,
    askUntracked,
    untrackedGone,
    askDeleted,
    toasts,
    entries: diff.count(),
  }
}
