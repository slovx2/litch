// 侧栏里不靠浏览器就能测的那几块判断。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { isQuiet, NO_TALLY, tallyOf, tallyParts, waitLabel } = await import(
  '../src/sidebar/tally.ts'
)

const tally = (approval, answer, running, unread) => ({ approval, answer, running, unread })

/** 数据副本给的样子：组 → harness → 这一组里它的会话的状况 */
const TALLIES = {
  litch: { claude: tally(1, 0, 1, 0), pi: tally(0, 0, 0, 1) },
  docs: { pi: tally(0, 2, 0, 1) },
  ':pinned': { codex: tally(0, 0, 3, 0) },
}

test('汇总：一组的是组里各个 harness 加起来，整台设备的是各组加起来', () => {
  assert.deepEqual(tallyOf(TALLIES, 'litch'), tally(1, 0, 1, 1))
  assert.deepEqual(tallyOf(TALLIES, null), tally(1, 2, 4, 2))
  // 数据副本只记有事的组：不在里面的就是什么事都没有；数据还没到也一样
  assert.deepEqual(tallyOf(TALLIES, 'infra'), NO_TALLY)
  assert.equal(tallyOf(undefined, 'litch'), NO_TALLY)
  assert.deepEqual(tallyOf({}, null), NO_TALLY)
  // 合计不许改到原来的数上
  assert.deepEqual(NO_TALLY, tally(0, 0, 0, 0))
  assert.deepEqual(TALLIES.litch.claude, tally(1, 0, 1, 0))
})

test('汇总：只看某个 harness 时，在跑的、未读的只算它的，等人的照样都算', () => {
  // 只看 Pi：Claude Code 那个在跑的不算了，它那个等审批的还算（那一行筛选时也留在树里）
  assert.deepEqual(tallyOf(TALLIES, 'litch', 'pi'), tally(1, 0, 0, 1))
  assert.deepEqual(tallyOf(TALLIES, 'litch', 'claude'), tally(1, 0, 1, 0))
  assert.deepEqual(tallyOf(TALLIES, null, 'pi'), tally(1, 2, 0, 2))
  assert.deepEqual(tallyOf(TALLIES, null, 'codex'), tally(1, 2, 3, 0))
  // 这一组里没有它的会话：只剩等人的
  assert.deepEqual(tallyOf(TALLIES, ':pinned', 'pi'), NO_TALLY)
  assert.deepEqual(tallyOf(TALLIES, 'docs', 'dsh'), tally(0, 2, 0, 0))
})

test('汇总：什么事都没有才算安静', () => {
  assert.equal(isQuiet(NO_TALLY), true)
  for (const busy of [tally(1, 0, 0, 0), tally(0, 1, 0, 0), tally(0, 0, 1, 0), tally(0, 0, 0, 1)]) {
    assert.equal(isQuiet(busy), false)
  }
})

test('汇总：等人的小标只有一种时和会话行上的字一样，两种都有换一个说法', () => {
  assert.equal(waitLabel(tally(2, 0, 5, 5)), 'sidebar.waitApproval')
  assert.equal(waitLabel(tally(0, 1, 0, 0)), 'sidebar.waitAnswer')
  assert.equal(waitLabel(tally(1, 3, 0, 0)), 'sidebar.waitBoth')
  assert.equal(waitLabel(tally(0, 0, 4, 4)), null)
})

test('汇总：具体的数目一样一句，要紧的在前，没有的不说', () => {
  assert.deepEqual(tallyParts(tally(1, 2, 3, 4)), [
    { key: 'sidebar.tally.approval', count: 1 },
    { key: 'sidebar.tally.answer', count: 2 },
    { key: 'sidebar.tally.running', count: 3 },
    { key: 'sidebar.tally.unread', count: 4 },
  ])
  assert.deepEqual(tallyParts(tally(0, 0, 2, 0)), [{ key: 'sidebar.tally.running', count: 2 }])
  assert.deepEqual(tallyParts(NO_TALLY), [])
})

// ---------- 侧栏的宽度与开合 ----------

/** 假的本地存储：只有读和写 */
const stored = new Map()
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
}
const saved = () => JSON.parse(stored.get('litch.sidebar') ?? 'null')

test('侧栏的宽度：窗口够宽照想要的来，窗口窄了自己收窄，再窄也不小于最窄', async () => {
  const { drawnWidth, REST_MIN, SIDEBAR_MAX, SIDEBAR_MIN, widthLimit } = await import(
    '../src/sidebar/state.ts'
  )
  const { MAIN_FLOOR, SIDE_FLOOR } = await import('../src/side/side.ts')
  // 给右边留的地方，就是侧面板那边“两样各让到底”的宽度之和
  assert.equal(REST_MIN, MAIN_FLOOR + SIDE_FLOOR)
  // 宽的窗口：最宽到上限
  assert.equal(widthLimit(1360), SIDEBAR_MAX)
  assert.equal(drawnWidth(360, 1360), 360)
  assert.equal(drawnWidth(2000, 1360), SIDEBAR_MAX)
  assert.equal(drawnWidth(0, 1360), SIDEBAR_MIN)
  // 最窄的窗口（900）：右边留够之后只剩 300
  assert.equal(widthLimit(900), 300)
  assert.equal(drawnWidth(360, 900), 300)
  assert.equal(drawnWidth(260, 900), 260)
  // 比最窄的窗口还窄（普通浏览器里）：侧栏不再往下收，让的是右边
  assert.equal(widthLimit(700), SIDEBAR_MIN)
  assert.equal(drawnWidth(360, 700), SIDEBAR_MIN)
  // 中间是连着的，不跳
  assert.equal(drawnWidth(480, 1000), 400)
  assert.equal(drawnWidth(480, 1001), 401)
})

test('侧栏的宽度：写成样式的那一份和算出来的是一回事', async () => {
  const { drawnWidth, widthCss } = await import('../src/sidebar/state.ts')
  /** 照样式的写法算一遍：只认这里用到的 clamp、max、min、像素、100vw 和减法 */
  const evaluate = (css, viewport) => {
    const js = css
      .replaceAll('clamp(', 'clamp_(')
      .replaceAll('max(', 'Math.max(')
      .replaceAll('min(', 'Math.min(')
      .replaceAll('100vw', String(viewport))
      .replaceAll('px', '')
    return new Function('clamp_', `return ${js}`)((low, value, high) =>
      Math.max(low, Math.min(value, high)),
    )
  }
  for (const viewport of [640, 900, 1000, 1100, 1360, 2560]) {
    for (const wanted of [240, 300, 360, 480]) {
      assert.equal(evaluate(widthCss(wanted), viewport), drawnWidth(wanted, viewport))
    }
  }
})

test('侧栏的状态：没记过就是开着、默认宽度；改了就记下来', async () => {
  stored.clear()
  const state = await import('../src/sidebar/state.ts?fresh')
  assert.deepEqual(state.sidebarNow(), {
    open: true,
    width: state.SIDEBAR_DEFAULT,
    harness: null,
  })
  state.setSidebarWidth(356.4)
  assert.deepEqual(saved(), { open: true, width: 356, harness: null })
  // 存的是想要的宽度，夹在最窄和最宽之间
  state.setSidebarWidth(5000)
  assert.equal(state.sidebarNow().width, state.SIDEBAR_MAX)
  state.setSidebarWidth(1)
  assert.equal(state.sidebarNow().width, state.SIDEBAR_MIN)
  state.setSidebarOpen(false)
  assert.deepEqual(saved(), { open: false, width: state.SIDEBAR_MIN, harness: null })
  // 只看哪个 harness 也记在这一份里；取消就是记回“都看”
  state.setSidebarHarness('pi')
  assert.deepEqual(saved(), { open: false, width: state.SIDEBAR_MIN, harness: 'pi' })
  state.setSidebarHarness(null)
  assert.equal(saved().harness, null)
})

test('侧栏的状态：记着的照记着的来，离谱的宽度拉回范围里；同一次按键来两回只算一回', async () => {
  stored.clear()
  stored.set('litch.sidebar', JSON.stringify({ open: false, width: 9999, harness: 'codex' }))
  const state = await import('../src/sidebar/state.ts?remembered')
  assert.deepEqual(state.sidebarNow(), {
    open: false,
    width: state.SIDEBAR_MAX,
    harness: 'codex',
  })
  state.toggleSidebar()
  // 应用菜单的快捷键和页面自己的按键各来一次：第二次不算
  state.toggleSidebar()
  assert.equal(state.sidebarNow().open, true)
  await new Promise((done) => setTimeout(done, 200))
  state.toggleSidebar()
  assert.equal(state.sidebarNow().open, false)
  // 存的东西读不出来：用默认的
  stored.set('litch.sidebar', '不是 JSON')
  const broken = await import('../src/sidebar/state.ts?broken')
  assert.deepEqual(broken.sidebarNow(), {
    open: true,
    width: broken.SIDEBAR_DEFAULT,
    harness: null,
  })
  // 记着的 harness 不是字符串：当成没在筛
  stored.set('litch.sidebar', JSON.stringify({ harness: 3 }))
  const odd = await import('../src/sidebar/state.ts?odd')
  assert.equal(odd.sidebarNow().harness, null)
})

// ---------- 只看某个 harness 的会话 ----------

const { describeHarness, harnessChoices, keepSessions } = await import('../src/sidebar/filter.ts')

const harness = (id, name, badge) => ({ id, name, badge })
const device = (connection, ...harnesses) => ({ connection, harnesses })
const CLAUDE = harness('claude', 'Claude Code', 'CC')
const PI = harness('pi', 'Pi', 'PI')
const CODEX = harness('codex', 'Codex', 'CX')

test('筛选：能挑的是连着的设备上的 harness，同一个只出一次，按设备和声明的先后', () => {
  const devices = [
    device('online', CLAUDE, PI),
    // 这台的数据还没到
    undefined,
    device('online', PI, CODEX),
    device('offline', harness('dsh', 'DeepSeek Harness', 'DS')),
  ]
  assert.deepEqual(harnessChoices(devices), [CLAUDE, PI, CODEX])
  // 一共只有一个：没什么可挑的（入口按“不到两个”不出现）
  assert.deepEqual(harnessChoices([device('online', CODEX), device('reconnecting', PI)]), [CODEX])
  assert.deepEqual(harnessChoices([]), [])
})

test('筛选：正筛着的那个怎么称呼——先看连着的设备，再看没连着的，都没有用它的标识', () => {
  const devices = [
    device('offline', harness('pi', '旧名字', 'P0'), harness('dsh', 'DeepSeek Harness', 'DS')),
    device('online', PI),
  ]
  assert.deepEqual(describeHarness(devices, 'pi'), PI)
  assert.deepEqual(describeHarness(devices, 'dsh'), harness('dsh', 'DeepSeek Harness', 'DS'))
  assert.deepEqual(describeHarness(devices, 'gone'), harness('gone', 'gone', 'GO'))
})

test('筛选：一组里只留这个 harness 的会话，先后不变；正选中的、等人的不筛掉', () => {
  const ids = ['s1', 's2', 's3', 's4', 's5']
  const harnessOf = { s1: 'claude', s2: 'claude', s3: 'pi', s4: 'codex', s5: 'pi' }
  const never = () => false
  // 没在筛：原样给回去，连数组都是同一个
  assert.equal(keepSessions(ids, null, harnessOf, never), ids)
  assert.deepEqual(keepSessions(ids, 'pi', harnessOf, never), ['s3', 's5'])
  assert.deepEqual(keepSessions(ids, 'dsh', harnessOf, never), [])
  // s2 在等审批、s4 正开着：不属于 Pi 也留着，位置不动
  const always = (id) => id === 's2' || id === 's4'
  assert.deepEqual(keepSessions(ids, 'pi', harnessOf, always), ['s2', 's3', 's4', 's5'])
  // 这一组没有会话；属于谁的那张表还没到
  assert.deepEqual(keepSessions(undefined, 'pi', harnessOf, never), [])
  assert.deepEqual(keepSessions(ids, 'pi', undefined, always), ['s2', 's4'])
})

// ---------- 会话的工作目录不是工作区的根 ----------

const { cwdMark } = await import('../src/sidebar/cwd.ts')

test('工作目录的记号：正好是工作区的根不出；在根下面是子目录；哪个根下面都不在是另一种', () => {
  const roots = ['/srv/work/litch']
  assert.equal(cwdMark('/srv/work/litch', roots), null)
  assert.deepEqual(cwdMark('/srv/work/litch/apps/desktop', roots), {
    kind: 'sub',
    rel: 'apps/desktop',
  })
  assert.deepEqual(cwdMark('/var/cache/ci', roots), { kind: 'away', rel: null })
  // 名字只是开头一样的兄弟目录不算在下面
  assert.deepEqual(cwdMark('/srv/work/litch-old', roots), { kind: 'away', rel: null })
  // 根的上一层也不算
  assert.deepEqual(cwdMark('/srv/work', roots), { kind: 'away', rel: null })
})

test('工作目录的记号：写法不一样的同一个目录算一回事', () => {
  // 末尾多一个分隔符、连着两个分隔符
  assert.equal(cwdMark('/srv/work/litch/', ['/srv/work/litch']), null)
  assert.equal(cwdMark('/srv/work/litch', ['/srv/work//litch/']), null)
  // 主目录的简写、Windows 的写法：只比字符串，照样认得出子目录
  assert.deepEqual(cwdMark('~/work/docs-site/content/guide', ['~/work/docs-site']), {
    kind: 'sub',
    rel: 'content/guide',
  })
  assert.deepEqual(cwdMark('C:\\work\\app\\web', ['C:\\work\\app']), { kind: 'sub', rel: 'web' })
  // 工作区的根就是整个盘
  assert.deepEqual(cwdMark('/srv', ['/']), { kind: 'sub', rel: 'srv' })
  assert.equal(cwdMark('/', ['/']), null)
})

test('工作目录的记号：macOS 上 /private/tmp 和 /tmp 是一处，按设备的系统给的另一种写法认', async () => {
  // 另一种写法由核心按设备的系统给（这里直接用核心的那份，它不引别的文件，Node 读得了）
  const { pathTwin } = await import('../../core/src/text/paths.mts')
  const roots = ['/tmp/w/tri']
  const mac = pathTwin('macos')
  assert.equal(cwdMark('/private/tmp/w/tri', roots, mac), null)
  assert.deepEqual(cwdMark('/private/tmp/w/tri/src', roots, mac), { kind: 'sub', rel: 'src' })
  assert.equal(cwdMark('/var/folders/x/app', ['/private/var/folders/x/app/'], mac), null)
  assert.deepEqual(cwdMark('/private/tmp/w/trio', roots, mac), { kind: 'away', rel: null })
  // Linux 上不认；不给就只比字面
  assert.deepEqual(cwdMark('/private/tmp/w/tri', roots, pathTwin('linux')), {
    kind: 'away',
    rel: null,
  })
  assert.deepEqual(cwdMark('/private/tmp/w/tri', roots), { kind: 'away', rel: null })
})

test('工作目录的记号：工作区有几个根；没有根可比的不出', () => {
  const roots = ['/work/app', '/work/app/web', '/data']
  // 正好是其中一个根：不出，哪怕它同时在另一个根的下面
  assert.equal(cwdMark('/work/app/web', roots), null)
  // 同时在两个根下面：照贴得最近的那个说
  assert.deepEqual(cwdMark('/work/app/web/src', roots), { kind: 'sub', rel: 'src' })
  assert.deepEqual(cwdMark('/data/sets/a', roots), { kind: 'sub', rel: 'sets/a' })
  // 没有归属的会话（没有工作区）、工作区没有根、目录是空的
  assert.equal(cwdMark('/work/app/web', undefined), null)
  assert.equal(cwdMark('/work/app/web', []), null)
  assert.equal(cwdMark('/work/app/web', ['']), null)
  assert.equal(cwdMark('', roots), null)
})
