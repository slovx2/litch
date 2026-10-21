// 终端验收的第二段，接在 probe-terminal.mts 的 mockBasics 后面（两个标签都开着，第一个叫“构建”）：
// 切走再回来内容和滚到哪了还在不在、刷屏的时候界面卡不卡、能不能切标签、中断多久生效、全屏程序进出。
// 最后面的 mockHome 排在整套验收的末尾：新建对话页上换设备、换项目，面板里的那一组跟着换。
import type { TerminalKit } from './probe-terminal-kit.mjs'

export interface MockFlow {
  /** 往上滚过之后屏幕上是另一截内容（确实滚动了） */
  scrolled: boolean
  /** 切到另一个标签再回来、收起面板再打开、换到别的项目的会话再回来、开一页再回来：显示的还是那一截 */
  keptAcrossTabs: boolean
  keptAcrossPanel: boolean
  keptAcrossSession: boolean
  keptAcrossPage: boolean
  /** 换到别的项目的会话时，面板里是那个项目自己的一组（这里是空的） */
  otherGroupEmpty: boolean
  /** 开着“设备”那一页的时候面板不显示 */
  hiddenOnPage: boolean
  /** 刷屏期间的帧间隔（毫秒）：中位数、95 分位、最大 */
  floodFrames: number
  floodMedian: number
  floodP95: number
  floodMax: number
  /** 刷屏期间屏幕在动（不是卡住了最后才出来） */
  floodMoved: number
  /** 刷屏的时候切到另一个标签敲一条命令，多久出结果（毫秒） */
  switchMs: number
  /** 回到刷屏的那个标签按中断键，多久之后提示符回来（毫秒） */
  interruptMs: number
  interrupted: boolean
  /** 刷屏期间终端里说过几次“略过了一段输出” */
  gapsNoted: number
  /** 进全屏：原来的内容不在屏幕上了；退出来：原来的内容原样回来 */
  fullEntered: boolean
  fullTicked: boolean
  fullRestored: boolean
}

export async function mockFlow(): Promise<MockFlow> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, all, text, frame, sleep } = kit
  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.every((row, at) => row === b[at])

  // ---------- 内容和滚到哪了 ----------
  await kit.pick(0)
  kit.run('flood 400')
  await kit.see('刷完了', 'flood 完成：400 行', 30_000)
  await kit.prompt()
  const bottom = kit.rows()
  kit.turn(-2)
  await until('滚上去了', () => !same(kit.rows(), bottom), 5000)
  const held = await kit.steady()
  const scrolled = !held.join('\n').includes('flood 完成') && /^\d{9} \| /.test(held[0] ?? '')

  await kit.pick(1)
  await kit.pick(0)
  const keptAcrossTabs = await kit.seen(() => same(kit.rows(), held), 3000)

  kit.toggle()
  await until('面板收起', () => !kit.panelOpen())
  // 紧挨着的两次开合只算一次（同一次按键可能从菜单和页面各来一遍），所以隔一会儿再点
  await sleep(250)
  kit.toggle()
  await until('面板再打开', () => kit.panelOpen())
  await frame()
  const keptAcrossPanel = await kit.seen(() => same(kit.rows(), held), 3000)

  // 换到别的项目的会话：面板里换成那个项目的一组
  const group = () => kit.panel()?.dataset.group ?? ''
  const home = group()
  const homeTitle = text(one('.ss-row[aria-current="true"] .title'))
  /** 侧栏里原来选着的那一行（行可能重画过，按标题现找） */
  const homeRow = () => all('.ss-row').find((row) => text(one('.title', row)) === homeTitle) ?? null
  let otherGroupEmpty = false
  let keptAcrossSession = false
  for (const row of all('.ss-row')) {
    if (row === homeRow()) continue
    row.click()
    // 这一行选中了，面板也就跟着换了组（同一次重画里的事）。会话的摘要晚到一拍的话面板会先收着，再等它出来
    if (!(await kit.seen(() => row.getAttribute('aria-current') === 'true', 3000))) continue
    await kit.seen(() => group() !== '' && kit.panelOpen(), 2000)
    if (group() && group() !== home) {
      otherGroupEmpty = kit.tabs().length === 0 && Boolean(one('.term-empty'))
      break
    }
  }
  homeRow()?.click()
  await until('回到原来的会话', () => group() === home)
  await until('原来的终端回到台上', () => one('.term-host.on'))
  await frame()
  // 回来之后终端要重画一遍：等到和走之前一样（一直不一样就是没留住）
  keptAcrossSession = await kit.seen(() => same(kit.rows(), held), 3000)

  // 开“设备”那一页再回来
  one<HTMLButtonElement>('.sb-settings')?.click()
  ;(
    await until('设置页上进设备页的入口', () =>
      one<HTMLButtonElement>('.set-go[data-page="devices"]'),
    )
  ).click()
  await until('设备页打开', () => text(one('.crumb b')) === '设备')
  const hiddenOnPage = !kit.panelOpen()
  homeRow()?.click()
  await until('回到对话', () => kit.panelOpen() && one('.term-host.on'))
  await frame()
  const keptAcrossPage = await kit.seen(() => same(kit.rows(), held), 3000)

  // ---------- 刷屏 ----------
  await kit.pick(1)
  kit.run('flood')
  await until('开始刷了', () => /\d{9} \| the quick/.test(kit.screen()))
  const gaps: number[] = []
  let moved = 0
  let lastTop = ''
  let last = performance.now()
  const watchEnd = last + 2500
  while (performance.now() < watchEnd) {
    await frame()
    const now = performance.now()
    gaps.push(now - last)
    last = now
    const top = kit.rows()[0] ?? ''
    if (top !== lastTop) moved++
    lastTop = top
  }
  gaps.sort((a, b) => a - b)
  const at = (share: number) =>
    gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * share))] ?? 0

  // 它还在刷：切到另一个标签，那边照常能用
  const switchStart = performance.now()
  await kit.pick(0)
  kit.run('echo switched-ok')
  await kit.see('另一个标签能用', /\nswitched-ok/, 10_000)
  const switchMs = performance.now() - switchStart

  // 回来按中断键
  await kit.pick(1)
  const stillFlooding = /\d{9} \| the quick/.test(kit.lastLine()) || !/\$$/.test(kit.lastLine())
  const interruptStart = performance.now()
  kit.ctrl('c')
  await until('中断生效', () => /\^C/.test(kit.screen()) && /\$$/.test(kit.lastLine()), 30_000)
  const interruptMs = performance.now() - interruptStart
  // 停稳了：再等一会儿屏幕不再变
  // 提示符是这一段输出的最后一样东西：它出来之后屏幕就不该再动
  const settled = kit.rows()
  await sleep(400)
  const interrupted = stillFlooding && same(kit.rows(), settled)
  // 那一行说明写在少掉的地方，后面跟着的输出比能往回翻的多得多，早就滚走了：数终端记下的次数。
  // 说明的字写得对不对，在对着设备的那一种验收里看（那里能让它留在屏幕上）
  const gapsNoted = Number(one('.term-host.on')?.dataset.gaps ?? 0)

  // ---------- 全屏程序 ----------
  await kit.pick(0)
  // 敲键会自己回到最底下
  kit.run('echo before-fullscreen')
  await kit.see('记号', /\nbefore-fullscreen/)
  await kit.prompt()
  const plain = kit.rows()
  kit.run('fullscreen')
  await kit.see('全屏画面', '全屏程序（假的）')
  const fullEntered =
    !kit.screen().includes('before-fullscreen') && kit.screen().includes('按 q 退出')
  await kit.see('它在动', /已经刷新 [2-9]\d* 次/, 10_000)
  const fullTicked = true
  kit.key('q')
  await until('回到原来的屏幕', () => !kit.screen().includes('全屏程序'))
  await kit.prompt()
  const after = kit.rows()
  // 进去之前屏幕上的那些行原样回来了，只多了敲的那条命令和新的提示符（所以最上面一两行滚出去了）
  const filled = plain.filter((row) => row.length > 0)
  const fullRestored =
    filled.length > 4 &&
    filled.slice(2, -1).every((row) => after.includes(row)) &&
    after.some((row) => row.endsWith('$ fullscreen')) &&
    !after.join('\n').includes('已经刷新')

  return {
    scrolled,
    keptAcrossTabs,
    keptAcrossPanel,
    keptAcrossSession,
    keptAcrossPage,
    otherGroupEmpty,
    hiddenOnPage,
    floodFrames: gaps.length,
    floodMedian: at(0.5),
    floodP95: at(0.95),
    floodMax: gaps.at(-1) ?? 0,
    floodMoved: moved,
    switchMs,
    interruptMs,
    interrupted,
    gapsNoted,
    fullEntered,
    fullTicked,
    fullRestored,
  }
}

export interface MockHome {
  /** 回到新建对话页：面板里是默认去处的那一组（“设备/项目”，本机、不属于任何项目） */
  start: string
  /** 在页上换了一台设备：面板里是那台设备主目录的那一组 */
  afterDevice: string
  /** 再换到那台设备上的一个项目：面板里是那个项目的一组。wanted 是该是哪一组 */
  afterWorkspace: string
  wanted: string
  /** 换回本机：回到开头那一组 */
  back: string
}

/**
 * 新建对话页上的终端跟着页上选的去处走。排在最后跑：这时面板开着、里面一个终端都没有，
 * 换组不会顺手开出新的终端，不动前面几段数过的个数
 */
export async function mockHome(): Promise<MockHome> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, all } = kit
  const where = () => `${kit.panel()?.dataset.device ?? '?'}/${kit.panel()?.dataset.group ?? '?'}`
  const options = (kind: string) => all(`.pick[data-kind="${kind}"] .pick-opt`)
  /** 点开页上的一个选择器，选出要的那一项 */
  const choose = async (kind: string, wanted: (option: HTMLElement) => boolean) => {
    one<HTMLButtonElement>(`.pick[data-kind="${kind}"] .pick-btn`)?.click()
    const option = await until(`${kind} 的选项`, () => options(kind).find(wanted))
    option.click()
    await until('选择器收起', () => options(kind).length === 0)
    return option.dataset.option ?? ''
  }

  one<HTMLButtonElement>('.sb-link.new')?.click()
  await until('新建对话页', () => one('.new-hero'))
  // 前面几段跑完面板是开着的；万一收着就打开它
  if (!(await kit.seen(() => kit.panelOpen(), 2000))) kit.toggle()
  await until('面板跟到了页上的去处', () => kit.panelOpen() && where() === 'local/')
  const start = where()
  await choose('device', (option) => option.dataset.option === 'build')
  await until('面板换到另一台设备', () => where().startsWith('build/'))
  const afterDevice = where()
  // 那台设备上的头一个项目（“不属于任何项目”那一项的标识是空的）
  const workspace = await choose('workspace', (option) => Boolean(option.dataset.option))
  const wanted = `build/${workspace}`
  await until('面板换到那个项目', () => where() === wanted, 5000).catch(() => null)
  const afterWorkspace = where()
  await choose('device', (option) => option.dataset.option === 'local')
  await until('面板回到本机', () => where().startsWith('local/'), 5000).catch(() => null)
  return { start, afterDevice, afterWorkspace, wanted, back: where() }
}
