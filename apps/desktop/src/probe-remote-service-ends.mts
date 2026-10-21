// 远程设备第二遍验收的最后两段（总的说明在 probe-remote-service.mts）：
// 只有 codex 的机器上的提示和“重新检查”，那台机器“装上适配器”之后这边自己换过去；
// 设备服务用不了的三种情形（旧服务在跑、起不来、适配器太旧）各自的说法和下一步。
// “装上适配器”是页面打一行 LITCH_SIGNAL install，起自检的脚本在假机器上建一个记号文件。
import type { ServiceAliases } from './probe-remote-service.mjs'
import type { TerminalKit } from './probe-terminal-kit.mjs'

export interface ServiceGrow {
  /** 详情里“对面”那一行、提示的原话、给的安装命令 */
  factPeer: string
  hint: string
  hintCommand: string
  /** 点“重新检查”：真的又连了一次（状态离开过“已连接”），对面没变，还是只有 codex */
  rechecked: string[]
  stillCodex: boolean
  /** 那台机器装上了适配器，这边的连接断了一次：不用人管，连回来就是设备服务 */
  switched: boolean
  switchedPeer: string
  hintGone: boolean
  manageReady: boolean
  /** 换过去之后侧栏里是设备服务上的会话（按标题找前面建的那个），设备列表那一行也跟着换 */
  sessionsFollowed: boolean
  rowPeer: string
  /** 另一台连着同一份设备服务的也自己连回来了 */
  othersBack: boolean
}

export async function serviceGrow(aliases: ServiceAliases, opening: string): Promise<ServiceGrow> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, all, text } = kit
  const group = (name: string) =>
    all('.dev-group').find((element) => text(one('.dev-row .name', element)) === name)
  const item = (name: string) =>
    all('.devp-item').find((element) => text(one('.devp-name', element)) === name)
  const online = (name: string) => {
    const element = group(name)
    return Boolean(element && !element.classList.contains('off'))
  }
  /** 正开着的那台设备的详情。每次现找：设备换了模式，这一页会重画 */
  const detail = () => one('[data-detail]')
  const within = (selector: string) => {
    const page = detail()
    return page ? one(selector, page) : null
  }
  const peer = () => within('.devp-facts dd[data-peer]')?.dataset.peer ?? ''

  // ---- 一、只有 codex 的那台：照旧能用，详情里说了装上设备服务能多出什么、怎么装 ----
  one<HTMLButtonElement>('.sb-settings')?.click()
  ;(
    await until('设置页上进设备页的入口', () =>
      one<HTMLButtonElement>('.set-go[data-page="devices"]'),
    )
  ).click()
  const mine = await until('设备列表里只有 codex 的那台', () =>
    detail() ? null : item(aliases.grow),
  )
  one<HTMLButtonElement>('.devp-row', mine)?.click()
  await until('它的详情', detail)
  const box = await until('“只有 codex”的提示', () => within('[data-peer-hint="codex"]'))
  const factPeer = peer()
  const hint = text(box)
  const hintCommand = text(one('.cfail-cmd code', box))

  // ---- 二、“重新检查”：对面没变的时候，点了也真的重新认一次 ----
  const pill = () => within('.mng-title .pill')?.className ?? ''
  const rechecked: string[] = [pill()]
  const watch = new MutationObserver(() => {
    const now = pill()
    if (now && rechecked[rechecked.length - 1] !== now) rechecked.push(now)
  })
  watch.observe(document.body, { subtree: true, childList: true, attributes: true })
  ;(await until('“重新检查”', () => within('[data-act="recheck"]'))).click()
  await until(
    '又连了一次，回到已连接',
    () => rechecked.length >= 3 && pill().includes('ok') && within('[data-peer-hint="codex"]'),
    60_000,
  )
  watch.disconnect()
  const stillCodex = peer() === 'codex'

  // ---- 三、那台机器装上了适配器：下一次连接（这里是断线之后自己重连的那一次）就换成设备服务 ----
  kit.signal('install')
  kit.signal('drop')
  // 没有人点任何东西：等它自己变成完整模式
  const switched = Boolean(
    await until('自己换成了设备服务', () => peer() === 'service' && pill().includes('ok'), 120_000),
  )
  const switchedPeer = text(within('.devp-facts dd[data-peer]'))
  const manageReady = Boolean(
    await until('管理数据', () => within('[data-manage-state="ready"]'), 60_000),
  )
  const hintGone = !within('[data-peer-hint]')
  // 侧栏里它名下的会话换成了设备服务上的：前面在另一台（同一份服务）上建的那个也在
  const sessionsFollowed = Boolean(
    await until(
      '它名下列出设备服务上的会话',
      () => {
        const element = group(aliases.grow)
        return element && all('.ss-row', element).some((row) => text(row).includes(opening))
      },
      60_000,
    ).catch(() => null),
  )
  const othersBack = Boolean(
    await until('另一台也自己连回来', () => online(aliases.svc), 90_000).catch(() => null),
  )
  within('[data-act="back"]')?.click()
  const has = await until('设备列表上它那一行', () => {
    const element = detail() ? null : item(aliases.grow)
    return element ? one<HTMLElement>('.devp-has[data-peer]', element) : null
  })
  const rowPeer = has.dataset.peer ?? ''

  return {
    factPeer,
    hint,
    hintCommand,
    rechecked,
    stillCodex,
    switched,
    switchedPeer,
    hintGone,
    manageReady,
    sessionsFollowed,
    rowPeer,
    othersBack,
  }
}

/** 一台没连上的设备在侧栏里是怎么说的 */
export interface FailureSeen {
  /** 添加时预览里的标记：“种类或样式｜文字” */
  preview: string
  stage: string
  text: string
  /** 给了哪几步（文案的键）、带了哪几条命令 */
  guides: string[]
  commands: string[]
  /** 对面的原话（点开“详情”看到的） */
  detail: string
  /** 设备列表上的状态小标的样式 */
  pill: string
}

export interface ServiceFailures {
  /** 设备服务在跑的时候，预览里说得出上面有哪些可用的 harness（这一台只看不加） */
  previewRunning: string
  previewRunningNote: string
  legacy: FailureSeen
  down: FailureSeen
  old: FailureSeen
  /**
   * 新建对话页上把设备换成适配器太旧的那台：建不了的原因下面带着同一份“该怎么办”
   * （给了哪几步、哪几条命令），不用先去设备页才看得到
   */
  homeGuides: string[]
  homeCommands: string[]
  noPasswordField: boolean
}

export async function serviceFailures(aliases: ServiceAliases): Promise<ServiceFailures> {
  const kit = (window as unknown as { __termKit: TerminalKit }).__termKit
  const { until, one, all, text, frame } = kit
  const group = (name: string) =>
    all('.dev-group').find((element) => text(one('.dev-row .name', element)) === name)
  const item = (name: string) =>
    all('.devp-item').find((element) => text(one('.devp-name', element)) === name)
  const noPassword = () => !one('input[type="password"]')

  // ---- 一、预览：设备服务正在跑的那台说得出上面有什么；三台用不了的各是什么标记 ----
  await until('设备列表', () => !one('[data-detail]') && one('.devp-list'))
  ;(await until('“添加设备”', () => one<HTMLButtonElement>('.devp-add'))).click()
  await until('对话框', () => one('dialog.modal[open]'))
  const hostRow = (alias: string) =>
    all('.modal .host').find((row) => text(one('.nm', row)) === alias)
  await until('ssh 配置里的主机', () => hostRow(aliases.both) && hostRow(aliases.svcOld), 60_000)
  const settledPill = (alias: string) => {
    const row = hostRow(alias)
    const pill = row ? one('.pill', row) : null
    return pill && (pill.classList.contains('ok') || pill.classList.contains('err')) ? pill : null
  }
  const pillOf = (alias: string) => {
    const pill = settledPill(alias)
    return `${pill?.dataset.peer ?? pill?.className ?? ''}｜${text(pill)}`
  }
  const tick = (alias: string) =>
    one<HTMLInputElement>('input', hostRow(alias) as HTMLElement)?.click()
  tick(aliases.both)
  await until('看过了正在跑的那台', () => settledPill(aliases.both), 60_000)
  const previewRunning = pillOf(aliases.both)
  const previewRunningNote = text(one('.modal .check'))
  // 只是看一眼，不加它：把勾去掉
  tick(aliases.both)
  await until('说明收起', () => !one('.modal .check'))
  const failing = [aliases.legacy, aliases.svcDown, aliases.svcOld]
  for (const alias of failing) tick(alias)
  await until('三台都看过了', () => failing.every((alias) => settledPill(alias)), 90_000)
  const previews = failing.map(pillOf)
  let noPasswordField = noPassword()

  // ---- 二、加进来：各自停在对应的阶段上，说了原因和下一步，不是 ssh 的报错 ----
  one<HTMLButtonElement>('.modal button[type="submit"]')?.click()
  await until('对话框关上', () => !one('dialog.modal[open]'))
  const seen = async (alias: string, preview: string): Promise<FailureSeen> => {
    const note = await until(
      `${alias} 停在失败上`,
      () => {
        const element = group(alias)
        return element ? one<HTMLElement>('.cfail[data-stage]', element) : null
      },
      120_000,
    )
    const words = text(one('.cfail-text', note))
    const guides = all('[data-guide]', note).map((step) => step.dataset.guide ?? '')
    const commands = all('.cfail-cmd code', note).map(text)
    // “详情”里是对面的原话：点开来读
    const more = one<HTMLButtonElement>('.cfail-acts .mini[aria-expanded="false"]', note)
    more?.click()
    await frame()
    // 重试中的那台随时会重画：重新从侧栏里找
    const live = group(alias)
    const detail = text(live ? one('.cfail-detail', live) : null)
    const line = item(alias)
    return {
      preview,
      stage: note.dataset.stage ?? '',
      text: words,
      guides,
      commands,
      detail,
      pill: (line ? one('.devp-state .pill', line) : null)?.className ?? '',
    }
  }
  const legacy = await seen(aliases.legacy, previews[0] ?? '')
  const down = await seen(aliases.svcDown, previews[1] ?? '')
  const old = await seen(aliases.svcOld, previews[2] ?? '')
  noPasswordField &&= noPassword()

  // ---- 三、新建对话页上选到没连上的那台：原因和下一步当场就有 ----
  one<HTMLButtonElement>('.devp .arch-head .ibtn')?.click()
  await until('设备页关上', () => !one('.devp'))
  ;(await until('侧栏最上面的“新对话”', () => one<HTMLButtonElement>('.sb-link.new'))).click()
  const picker = () => one<HTMLButtonElement>('.pick[data-kind="device"] .pick-btn')
  await until('新建对话页', () => one('.new-hero') && picker())
  picker()?.click()
  const choice = await until('设备选择器里适配器太旧的那台', () =>
    all('.pick[data-kind="device"] .pick-opt').find(
      (option) => text(one('b', option)) === aliases.svcOld,
    ),
  )
  choice.click()
  const why = await until('建不了的说明', () =>
    text(picker()) === aliases.svcOld ? one('.new-why[data-down="device"]') : null,
  )
  await until('说明里的下一步', () => one('[data-guide]', why), 10_000).catch(() => null)
  const homeGuides = all('[data-guide]', why).map((step) => step.dataset.guide ?? '')
  const homeCommands = all('.cfail-cmd code', why).map(text)

  return {
    previewRunning,
    previewRunningNote,
    legacy,
    down,
    old,
    homeGuides,
    homeCommands,
    noPasswordField,
  }
}
