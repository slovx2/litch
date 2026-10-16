// 远程设备第二遍的验收：对面装了适配器（设备服务）的那几种情形。真的外壳对着假的远程机器
// （scripts/client-ssh-fixture.mjs 里“装了适配器”的那几个别名：真的适配器命令行，经 ssh 执行它的
// device-start 才把常驻服务拉起来，模型是回环上的假模型）。
// 这个文件是前一半：添加时的预览、连上之后是完整模式、管理页、整理工作区。
// 后一半（发消息、断线、终端、对面变了自己换过去、各种没连上）在 probe-remote-service-more.mts，
// 判定在 probe-remote-service-judge.mts，编排在 smoke.mts。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西；
// 等、找、读这几样手用的是终端验收那一套（probe-terminal-kit.mts，先装进页面）。
import type { TerminalKit } from './probe-terminal-kit.mjs'

/** 假的远程机器上这一遍要用的几个别名 */
export interface ServiceAliases {
  /** 装了适配器，没有 codex */
  svc: string
  /** 适配器和 codex 都有，和 svc 是同一台 */
  both: string
  /** 一开始只有 codex，“装上适配器”之后和 svc 是同一台 */
  grow: string
  /** 状态目录上跑着一份不带聚合面的旧服务 */
  legacy: string
  /** 设备服务起不来 */
  svcDown: string
  /** 适配器太旧 */
  svcOld: string
}

export interface ServiceConnect {
  /** 新建对话页上先说了本机没连上（这一遍也不给本机入口） */
  homeBlocked: string
  /** 添加设备时的预览：装了设备服务的（还没在跑）和只有 codex 的，各是什么标记、说了什么 */
  previewService: string
  previewServiceNote: string
  previewCodex: string
  previewCodexNote: string
  /** 连接途中侧栏上显示过的说明（走到哪一步） */
  notes: string[]
  /** 连上之后设备列表的那一行：说的是哪一种、几个 harness、各自的徽标 */
  rowPeer: string
  rowText: string
  chips: string[]
  /** 详情：事实栏里“对面”那一行，没有“只有 codex”的提示 */
  factPeer: string
  facts: string
  codexHint: boolean
  /** 管理数据读到了：各 harness 的状态、设备服务声明的设置项有多少 */
  manageReady: boolean
  harnesses: string[]
  settings: number
  /** 那台机器上在跑的设备服务是哪一份，经 ssh 一样读得到：版本｜来源是哪一种:来源｜是不是按需拉起的 */
  serviceFacts: string
  /** 只有 codex 的那台：列表上说“只有它” */
  growPeer: string
  growText: string
  /** 整理工作区：在远程设备上添加一个工作区，侧栏里出现了 */
  workspaceAdded: boolean
  workspaces: string[]
  noPasswordField: boolean
}

export async function serviceConnect(
  aliases: ServiceAliases,
  work: string,
): Promise<ServiceConnect> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, all, text, frame } = kit
  const write = (target: HTMLInputElement, words: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(target, words)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  /** 侧栏里的一台设备 */
  const group = (name: string) =>
    all('.dev-group').find((element) => text(one('.dev-row .name', element)) === name)
  /** 设备列表里的一台设备 */
  const item = (name: string) =>
    all('.devp-item').find((element) => text(one('.devp-name', element)) === name)
  const online = (name: string) => {
    const element = group(name)
    return Boolean(element && !element.classList.contains('off'))
  }
  const noPassword = () => !one('input[type="password"]')

  // ---- 一、添加设备：预览里说出对面是哪一种 ----
  await until('新建对话页', () => one('.new-hero'), 60_000)
  const toDevices = await until(
    '说明里去“设备”一页的按钮',
    () => one<HTMLButtonElement>('.new-why[data-down="device"] [data-act="open-devices"]'),
    60_000,
  )
  const homeBlocked = text(one('.dock .cmp-hint.err'))
  toDevices.click()
  await until('设备页', () => one('.devp'))
  let noPasswordField = noPassword()
  ;(await until('“添加设备”', () => one<HTMLButtonElement>('.devp-add'))).click()
  await until('对话框', () => one('dialog.modal[open]'))
  const hostRow = (alias: string) =>
    all('.modal .host').find((row) => text(one('.nm', row)) === alias)
  await until('ssh 配置里的主机', () => hostRow(aliases.svc) && hostRow(aliases.grow), 60_000)
  const settledPill = (alias: string) => {
    const row = hostRow(alias)
    const pill = row ? one('.pill', row) : null
    return pill && (pill.classList.contains('ok') || pill.classList.contains('err')) ? pill : null
  }
  for (const alias of [aliases.svc, aliases.grow]) {
    one<HTMLInputElement>('input', hostRow(alias) as HTMLElement)?.click()
  }
  await until('两台都看过了', () => settledPill(aliases.svc) && settledPill(aliases.grow), 60_000)
  const pillOf = (alias: string) => {
    const pill = settledPill(alias)
    return `${pill?.dataset.peer ?? pill?.className ?? ''}｜${text(pill)}`
  }
  const previewService = pillOf(aliases.svc)
  const previewCodex = pillOf(aliases.grow)
  const previewServiceNote = text(one('.modal .check[data-peer="service"]'))
  const previewCodexNote = text(one('.modal .check[data-peer="codex"]'))
  noPasswordField &&= noPassword()

  // ---- 二、加进来：设备服务是连的时候才拉起来的，途中说了走到哪一步 ----
  one<HTMLButtonElement>('.modal button[type="submit"]')?.click()
  await until('对话框关上', () => !one('dialog.modal[open]'))
  const notes: string[] = []
  await until(
    '装了设备服务的那台连上',
    () => {
      // 只看这台设备自己的：没给范围的话会找到别的设备头上去
      const element = group(aliases.svc)
      const note = element ? text(one('.dev-note', element)) : ''
      if (note && notes[notes.length - 1] !== note) notes.push(note)
      return online(aliases.svc)
    },
    90_000,
  )
  await until(
    '只有 codex 的那台连上并列出会话',
    () => {
      const element = group(aliases.grow)
      return element && online(aliases.grow) && all('.ss-row', element).length > 0
    },
    90_000,
  )

  // ---- 三、设备列表和详情：说得出对面是设备服务、上面有哪些 harness ----
  const mine = await until('设备列表里的这台设备', () => item(aliases.svc))
  const has = await until('这一行说出对面是哪一种', () =>
    one<HTMLElement>('.devp-has[data-peer]', mine),
  )
  const rowPeer = has.dataset.peer ?? ''
  const rowText = text(one('.devp-sub', has))
  const chips = all('.devp-chips .chip[data-harness]', mine).map(
    (chip) => `${chip.dataset.harness}:${chip.classList.contains('off') ? 'off' : 'on'}`,
  )
  const growHas = await until('只有 codex 的那一行', () => {
    const element = item(aliases.grow)
    return element ? one<HTMLElement>('.devp-has[data-peer]', element) : null
  })
  const growPeer = growHas.dataset.peer ?? ''
  const growText = text(one('.devp-sub', growHas))
  one<HTMLButtonElement>('.devp-row', mine)?.click()
  const page = await until('这台设备的详情', () => one('[data-detail]'))
  noPasswordField &&= noPassword()
  // 管理数据是经 ssh 从那台机器的设备服务上读回来的
  const manageReady = Boolean(
    await until('管理数据', () => one('[data-manage-state="ready"]', page), 60_000),
  )
  await until(
    'Pi 可用',
    () => one('[data-harness-block="pi"]', page)?.dataset.state === 'ready',
    60_000,
  )
  const factPeer = one('.devp-facts dd[data-peer]', page)?.dataset.peer ?? ''
  const facts = all('.devp-facts dd', page).map(text).join('｜')
  const codexHint = Boolean(one('[data-peer-hint]', page))
  const harnesses = all('[data-harness-block]', page).map(
    (block) => `${block.dataset.harnessBlock}:${block.dataset.state}`,
  )
  // “设备服务”一节：对面报的来历可能比握手晚一点到，等它出来。它和设置项一样收着
  await until('“设备服务”一节', () => one('[data-sec="service"]', page), 30_000)
  // 设置项都收着：点开了才数得到
  for (let round = 0; round < 20; round++) {
    const closed = all('.fold[aria-expanded="false"]', page)
    if (closed.length === 0) break
    for (const fold of closed) fold.click()
    await frame()
  }
  const settings = all('[data-setting]', page).length
  const serviceFact = (name: string) => one(`[data-sec="service"] [data-fact="${name}"]`, page)
  const serviceFacts = [
    text(serviceFact('version')),
    `${serviceFact('origin')?.dataset.origin}:${text(serviceFact('origin'))}`,
    serviceFact('launch')?.dataset.detached ?? '',
  ].join('｜')

  // ---- 四、整理工作区：工作区记在那台机器的设备服务上，经远程连接照样能加 ----
  one<HTMLButtonElement>('[data-act="back"]', page)?.click()
  await until('回到设备列表', () => !one('[data-detail]') && one('.devp-list'))
  one<HTMLButtonElement>('.devp .arch-head .ibtn')?.click()
  await until('设备页关上', () => !one('.devp'))
  const remote = group(aliases.svc) as HTMLElement
  ;(
    await until('远程设备那一行的“更多”', () =>
      one<HTMLButtonElement>(':scope > .row-line > .row-more > .ibtn', remote),
    )
  ).click()
  ;(
    await until('菜单里的“添加工作区”', () =>
      one<HTMLButtonElement>('.row-more .pick-opt[data-action="addWorkspace"]', remote),
    )
  ).click()
  await until('添加工作区的对话框', () => one('dialog.ws-dialog[open]'))
  write(await until('目录那一栏', () => one<HTMLInputElement>('#ws-root')), work)
  write(await until('名字那一栏', () => one<HTMLInputElement>('#ws-name')), '远程区')
  await frame()
  one<HTMLButtonElement>('.ws-dialog .btn.primary')?.click()
  await until('对话框关掉', () => !one('dialog.ws-dialog[open]'))
  const names = () => all('[data-workspace] .name', remote).map(text)
  const workspaceAdded = Boolean(
    await until('新的工作区出现在侧栏里', () => names().includes('远程区')).catch(() => null),
  )

  return {
    homeBlocked,
    previewService,
    previewServiceNote,
    previewCodex,
    previewCodexNote,
    notes,
    rowPeer,
    rowText,
    chips,
    factPeer,
    facts,
    codexHint,
    manageReady,
    harnesses,
    settings,
    serviceFacts,
    growPeer,
    growText,
    workspaceAdded,
    workspaces: names(),
    noPasswordField,
  }
}
