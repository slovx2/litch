// 终端验收里对着真 shell 的那几段：隔离的设备夹具（可重连的终端）和单个 harness 的入口（随连接结束的终端）。
// 夹具起的 shell 用夹具自己的临时主目录，读不到用户的 shell 配置。编排在 probe-terminal-run.mts。
// 命令里的记号都写成算式（echo hello-$((40+2))）：敲进去的那一行里没有结果的字样，屏幕上出现了就一定是程序打出来的。
import type { TerminalKit } from './probe-terminal-kit.mjs'

export interface RealBasics {
  /** 选着的会话的标题（核心重启之后要按它找回来） */
  session: string
  firstTab: string
  /** 标了“随连接结束”没有 */
  ephemeralPill: boolean
  /** 标签栏上写的目录，和 shell 自己说的目录 */
  cwdShown: string
  pwd: string
  echoed: boolean
  /** 敲一个键到它显示出来，每个键各花了多久（毫秒）：这是端到端的，过了设备和真 shell */
  echoMs: number[]
  /** 全屏程序（less）：占了整屏、能翻页、退出之后原来的屏幕回来 */
  fullEntered: boolean
  fullPaged: boolean
  fullRestored: boolean
}

export async function realBasics(): Promise<RealBasics> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, text } = kit
  // 有会话就选第一个：终端开在它的项目里。没有会话的话用的是设备主目录的那一组
  await until('侧栏里有会话', () => one('.ss-row'), 30_000).catch(() => null)
  const first = one<HTMLElement>('.ss-row')
  first?.click()
  if (first) await kit.seen(() => first.getAttribute('aria-current') === 'true')
  const session = text(one('.ss-row[aria-current="true"] .title'))
  kit.toggle()
  await until('面板打开', () => kit.panelOpen())
  await until('顺手开出一个终端', () => kit.tabs().length === 1, 30_000)
  await until('终端起来了', () => kit.tabs()[0]?.state === 'running', 30_000)
  await kit.calm()
  await kit.prompt(30_000)
  const firstTab = kit.tabs()[0]?.name ?? ''
  const ephemeralPill = Boolean(one('.term-eph'))
  const cwdShown = one('.term-cwd')?.getAttribute('title') ?? ''

  kit.run('pwd')
  const pwd = await until('pwd 的结果', () => kit.rows().find((row) => row.startsWith('/')))
  await kit.prompt()
  // 带一个大写字母：大写字母在终端控件里走的是另一条路（“按出字符”的事件）
  kit.run('echo Hello-$((40+2))')
  await kit.see('echo 的结果', /\nHello-42/)
  await kit.prompt()
  const echoed = kit.rows().includes('Hello-42')

  const echoMs: number[] = []
  for (const char of 'echotiming') echoMs.push(await kit.echo(char))
  // 这一行不要了
  kit.ctrl('c')
  await until('回到空的提示符', () => !kit.lastLine().includes('echotiming'))
  await kit.prompt()

  kit.run('echo before-$((9*9))')
  await kit.see('记号', /\nbefore-81/)
  await kit.prompt()
  kit.run('seq 1 300 | less')
  await until('less 的画面', () => kit.rows()[0] === '1' && !kit.screen().includes('before-81'))
  const count = kit.rows().length
  // less 占满整屏：最后一行是它的提示，上面是 1 到“行数减一”
  const fullEntered = kit.rows()[count - 2] === String(count - 1)
  kit.key(' ')
  await until('翻了一页', () => Number(kit.rows()[0]) > 1)
  const fullPaged = Number(kit.rows()[0]) === count
  kit.key('q')
  await until('回到原来的屏幕', () => kit.screen().includes('before-81'))
  await kit.prompt()
  const fullRestored = !kit.rows().includes('1') && kit.rows().includes('before-81')

  return {
    session,
    firstTab,
    ephemeralPill,
    cwdShown,
    pwd,
    echoed,
    echoMs,
    fullEntered,
    fullPaged,
    fullRestored,
  }
}

export interface DeviceDrop {
  /** 断线之后：标签说没连上，状态条说它还在设备上跑，原来的内容还在 */
  awayNote: string
  contentKept: boolean
  /** 断线期间程序打出来的东西，这时候当然还看不到 */
  notYet: boolean
  /** 连回来之后自己接回，断线期间的输出补上了，不多不少正好一次 */
  rejoined: boolean
  replayedOnce: boolean
  /** 没丢东西的时候不该说“少了一段” */
  gapsAfterShortDrop: number
  usable: boolean
  /** 断线期间的输出超过了设备留着的量：连回来之后终端里有一行说明 */
  gapLine: string
  gapsAfterLongDrop: number
  /** 说明后面，留着的那部分和之后的输出都在 */
  tailShown: boolean
  /** 这期间有没有因为界面跟不上而略过输出（不该有：补回来的量由核心限着） */
  backlogLine: string
}

export async function deviceDrop(): Promise<DeviceDrop> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, text, sleep } = kit
  // 前面刷屏的时候已经说过好些次“略过了”，从现在数起
  const gapsBefore = Number(one('.term-host.on')?.dataset.gaps ?? 0)
  const gaps = () => Number(one('.term-host.on')?.dataset.gaps ?? 0) - gapsBefore

  // ---------- 断一小会儿：期间的输出原样补回来 ----------
  // 先打一个记号再睡：看到记号，说明这一行命令对面已经收下、在跑了，这时候再断线
  kit.run('echo go-$((1+1)); sleep 3; echo after-drop-$((6*7))')
  await kit.see('命令跑起来了', /\ngo-2/)
  kit.signal('link down')
  await until('标成没连上', () => kit.tabs()[0]?.state === 'away', 30_000)
  const awayNote = text(one('.term-status[data-state="away"]'))
  const contentKept = kit.screen().includes('after-drop-$((6*7))')
  await sleep(4000)
  const notYet = !/\nafter-drop-42/.test(kit.screen())
  kit.signal('link up')
  await until('接回来了', () => kit.tabs()[0]?.state === 'running', 90_000)
  await kit.see('断线期间的输出补上了', /\nafter-drop-42/, 30_000)
  await kit.prompt()
  const rejoined = !one('.term-status')
  const replayedOnce = kit.screen().split('\nafter-drop-42').length === 2
  const gapsAfterShortDrop = gaps()
  kit.run('echo still-$((1+1))')
  await kit.see('还能接着用', /\nstill-2/)
  await kit.prompt()
  const usable = true

  // ---------- 断线期间输出了三兆：设备只留最后两兆 ----------
  // 输出全是回到行首重写同一行（没有换行），所以连回来之后那一行说明不会被滚走
  kit.run('clear')
  await kit.cleared()
  kit.run(
    "echo go-$((2+1)); sleep 2; yes 0123456789 | tr '\\n' '\\r' | head -c 3000000; echo; echo gap-$((20+3))",
  )
  await kit.see('命令跑起来了', /\ngo-3/)
  kit.signal('link down')
  await until('又标成没连上', () => kit.tabs()[0]?.state === 'away', 30_000)
  await sleep(6000)
  kit.signal('link up')
  await until('又接回来了', () => kit.tabs()[0]?.state === 'running', 90_000)
  await kit.see('后面的输出', /\ngap-23/, 60_000)
  await kit.prompt()
  const gapLine = kit.rows().find((row) => row.includes('没能补回来')) ?? ''
  const backlogLine = kit.rows().find((row) => row.includes('略过了')) ?? ''
  const gapsAfterLongDrop = gaps() - gapsAfterShortDrop
  const tailShown = kit.rows().includes('0123456789') && kit.rows().includes('gap-23')

  return {
    awayNote,
    contentKept,
    notYet,
    rejoined,
    replayedOnce,
    gapsAfterShortDrop,
    usable,
    gapLine,
    gapsAfterLongDrop,
    tailShown,
    backlogLine,
  }
}

export interface TabsMade {
  ids: string[]
  names: string[]
}

/** 核心重启之前：凑成两个标签，各留一个记号，第一个改个名字 */
export async function deviceTabs(): Promise<TabsMade> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, all } = kit
  kit.run('echo first-$((3*3))')
  await kit.see('第一个的记号', /\nfirst-9/)
  await kit.prompt()
  one<HTMLButtonElement>('.term-new')?.click()
  await until('第二个标签', () => kit.tabs().length === 2)
  await until('第二个上台', () => kit.tabs()[1]?.active)
  await kit.prompt(30_000)
  kit.run('echo second-$((2*11))')
  await kit.see('第二个的记号', /\nsecond-22/)
  await kit.prompt()

  all('.term-tab-btn')[0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  const field = await until('改名的输入框', () => one<HTMLInputElement>('.term-rename'))
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, '构建')
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  // 名字是先记到这台电脑上、再报给界面的：界面上改了，就已经落盘了
  await until('名字改了', () => kit.tabs()[0]?.name === '构建')
  return { ids: kit.tabs().map((tab) => tab.id), names: kit.tabs().map((tab) => tab.name) }
}

export interface Restored {
  panelOpen: boolean
  ids: string[]
  names: string[]
  states: string[]
  /** 各自的内容从设备上补回来了 */
  firstContent: boolean
  secondContent: boolean
  /** 接回来的终端还是原来那个 shell，能接着用 */
  alive: boolean
}

/** 核心重启、页面重新加载之后：同一个会话底下，标签按原来的顺序和名字回来 */
export async function deviceRestored(session: string): Promise<Restored> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, all, text } = kit
  const row = await until(
    '侧栏里原来那个会话',
    () => all('.ss-row').find((entry) => text(one('.title', entry)) === session),
    60_000,
  )
  row.click()
  await until('选中了原来那个会话', () => row.getAttribute('aria-current') === 'true')
  // 面板开没开是记在界面本地的：重新加载之后应当还开着。看的是开合按钮的状态，不是面板画出来没有
  // （面板那一块代码是用到才装载的，刚重新加载的时候可能还没画出来）
  const panelOpen = one('.tb-term')?.getAttribute('aria-pressed') === 'true'
  if (!panelOpen) kit.toggle()
  await until('面板画出来了', () => kit.panelOpen(), 60_000)
  await until('标签回来了', () => kit.tabs().length >= 2, 60_000)
  await until('都接上了', () => kit.tabs().every((tab) => tab.state === 'running'), 60_000)
  const tabs = kit.tabs()
  await kit.pick(0)
  await kit.see('第一个的内容', /\nfirst-9/, 30_000).catch(() => {})
  const firstContent = /\nfirst-9/.test(kit.screen())
  await kit.pick(1)
  await kit.see('第二个的内容', /\nsecond-22/, 30_000).catch(() => {})
  const secondContent = /\nsecond-22/.test(kit.screen())
  kit.run('echo alive-$((5+5))')
  await kit.see('接着用', /\nalive-10/, 30_000).catch(() => {})
  const alive = /\nalive-10/.test(kit.screen())
  return {
    panelOpen,
    ids: tabs.map((tab) => tab.id),
    names: tabs.map((tab) => tab.name),
    states: tabs.map((tab) => tab.state),
    firstContent,
    secondContent,
    alive,
  }
}
