// 设备与 harness 管理的验收，对着模拟核心的那一半：把详情页上的各种状态和控件过一遍。
// 详情一打开只露一眼要看的（harness 各一行，各节收成标题加摘要）：先看收着的时候是什么样、
// 收起展开好不好使，再把收着的都点开，去读、去改里面的设置项。
// 模拟核心里本机是一台能管理的设备（四个 harness，Claude Code 一开始就有回合在跑），
// “nas”没有设置接口，“gpu”能管理但没连上；别处的动静由对话里的关键字来演
// （“别处改设置”“抢先改设置”“加一项设置”，见 packages/core/src/mock/mock-core.mts）。
// 对着真的设备服务的那一半在 probe-manage.mts。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。

export interface MockManageProbe {
  /** 设备列表上每台设备的那一行：标识、里面有几个按钮（整行就是那一个）、几个输入控件 */
  entries: string[]
  /** 各台设备的详情里，“这台设备”一节能做的事：本机只能换线色，远程的有改名、改连接、移除，没连上的多一个重新连接 */
  deviceActs: string[]
  /** 没有设置接口的设备：只有连接信息，没有管理区的任何东西 */
  plainState: string
  plainShell: number
  plainFacts: number
  /** 能管理但没连上的设备：说一句，没有管理区；没连上的原因和对面的原话都在详情里 */
  offlineState: string
  offlineShell: number
  offlineWhy: string
  /**
   * 本机的详情一打开只露一眼要看的。收着的时候各露出几个：
   * 设置项/不可用的原因/环境文件里的变量/入口的状况/配置片段的按钮
   */
  foldedShown: string
  /** 每个 harness 的标题行：开没开着、标题行上的开关、重启按钮 */
  heads: string[]
  /** 收着的各节，标题后面那句摘要 */
  summaries: string[]
  /** 收起展开都是聚焦得到的按钮，带着开没开的状态和同一种箭头 */
  foldsReachable: boolean
  /** 点开不可用的那个 harness 再收起：开着:按钮的状态:内容在不在 > 收起之后 */
  foldToggles: string
  /** 本机：harness 和状态、不可用的那个的原因 */
  harnesses: string[]
  downReason: string
  /** 每种类型画成了什么控件；不认识的类型只读并说明 */
  controls: Record<string, string>
  unknownNote: string
  unknownEditable: boolean
  /** 已保存的密钥只显示“已设置” */
  secretShown: string
  envSecretShown: string
  envSecretHasInput: boolean
  inheritedSecret: string
  /** SSH 入口的状况 */
  sshStates: string[]
  sshFailedReason: string
  /** 切到英文：设备服务给的标题跟着换 */
  english: string
  /**
   * 在收着的 Pi 的标题行上拨开关：这一块自己开了、想收也收不起来，里面那一行的开关跟着变
   * （这一块开没开:标题行上的开关:行上的开关）
   */
  leadOpens: string
  /** 停用 Pi：保存条、状态、新建会话的选择器里没有它、它的会话标成不可用 */
  disableBar: number
  disabledState: string
  pickerWithout: string[]
  disabledRows: string
  disabledHint: string
  /** 再启用（拨的是里面那一行的开关）：标题行上的开关跟着变；恢复 */
  leadFollows: boolean
  enabledState: string
  pickerWith: string[]
  enabledRowsDown: number
  /** 加环境变量（一个普通的、一个密钥）和填一个密钥：保存后密钥只剩“已设置” */
  envSaved: string[]
  apiKeyAfter: string
  secretLeaks: string[]
  savedToast: string
  /** 改了要重启的设置而它有回合在跑：待重启；重启先问 */
  pendingShown: boolean
  pendingToast: string
  confirmTitle: string
  stillPending: boolean
  restarted: boolean
  /** 填得不对：界面自己拦的、设备服务不认的 */
  rangeProblem: string
  saveBlocked: boolean
  refused: string
  refusedKept: number
  fixedSaved: boolean
  /** 别处改了设置：开着的页面跟着变，正在改的那一栏不冲掉、标出来 */
  elsewhereConflict: string
  elsewhereMine: string
  elsewhereOther: string
  elsewhereBlocked: boolean
  keptMine: string
  /** 带着没保存的改动离开再回来：有改动的那一节自己开着，别的照旧收着（有改动的那一节:Pi 那一块） */
  draftReopened: string
  /** 别处抢先改了：保存得到冲突，什么都没覆盖，看到最新的值 */
  raceToast: string
  raceConflict: boolean
  raceOtherKept: boolean
  raceLatest: string
  raceSaved: string
  /** 设备服务多了一项设置：不改界面也看得到、改得了 */
  addedType: string
  addedSaved: string
  /** 诊断、日志、ssh 配置片段 */
  checks: string[]
  logTail: number
  logTruncated: boolean
  logEmptyNote: boolean
  configAvailable: string[]
  configUnavailable: string
  copied: string
  /** 放弃改动可以撤销 */
  discardUndo: string
  /** 远程设备是同一套界面 */
  remotePending: string[]
  /** 三种皮肤、深浅色：字和底分得开（设置的标题、说明、开着的开关，收着时标题行上的名字、标题后面的摘要） */
  skins: string[]
}

export async function mockManageProbe(): Promise<MockManageProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 30_000,
  ) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    throw new Error(`等不到：${what}`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  /** 像人那样往输入框里填字、在下拉框里选一项：React 只认原生的赋值加事件 */
  const fill = (target: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const choose = (target: HTMLSelectElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(target, value)
    target.dispatchEvent(new Event('change', { bubbles: true }))
  }
  // 复制不真的动系统剪贴板：接住要写进去的字
  const clipboard: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => void clipboard.push(value) },
  })

  const row = (key: string) => one(`[data-setting="${key}"]`)
  const input = (key: string) => one<HTMLInputElement>(`[data-setting="${key}"] input`)
  const select = (key: string) => one<HTMLSelectElement>(`[data-setting="${key}"] select`)
  const block = (id: string) => one(`[data-harness-block="${id}"]`)
  const bar = () => one('.mng-save')
  const dirty = () => Number(bar()?.dataset.dirtyCount ?? 0)
  const saveButton = () => one<HTMLButtonElement>('.mng-save [data-act="save"]')
  const toast = (id: string) => text(one(`.toast[data-toast="${id}"] .toast-text`))
  const act = (root: ParentNode | null, name: string) =>
    root ? one<HTMLButtonElement>(`[data-act="${name}"]`, root) : null
  /** 按保存，等保存条收掉 */
  const save = async () => {
    const button = await until('能按的“保存”', () => {
      const found = saveButton()
      return found && !found.disabled ? found : null
    })
    button.click()
    await until('保存条收掉', () => !bar())
  }
  /** 回到设备列表（在详情里的话先退出来），再点开一台设备的详情 */
  const openDetail = async (deviceId: string) => {
    if (one('[data-detail]')) act(document, 'back')?.click()
    else {
      one<HTMLButtonElement>('.sb-settings')?.click()
      ;(
        await until('设置页上进设备页的入口', () =>
          one<HTMLButtonElement>('.set-go[data-page="devices"]'),
        )
      ).click()
    }
    const item = await until(`设备列表上的 ${deviceId}`, () =>
      one('[data-detail]') ? null : one(`.devp-item[data-device="${deviceId}"]`),
    )
    one<HTMLButtonElement>('.devp-row', item)?.click()
    return until(`${deviceId} 的详情`, () => one(`[data-detail="${deviceId}"]`))
  }
  const ready = () => until('管理数据', () => one('[data-manage-state="ready"]'))
  /** 详情里收着的都点开：设置项、原因、入口的状况都在里面，点开了才读得到、改得了 */
  const unfold = async () => {
    for (let round = 0; round < 20; round++) {
      const closed = all('[data-detail] .fold[aria-expanded="false"]')
      if (closed.length === 0) return
      for (const fold of closed) fold.click()
      await frame()
    }
    throw new Error('详情里有收着的地方点不开')
  }
  /** “这台设备”一节里能做的事 */
  const actsOf = (page: Element) =>
    `${page.getAttribute('data-detail')}:${all('[data-sec="device"] [data-act]', page)
      .map((entry) => entry.dataset.act)
      .join('+')}`
  /** 本机侧栏里某个 harness 的会话（按徽标认） */
  const local = () => one('.dev-group') as HTMLElement
  const rowsOf = (badge: string) =>
    all('.ss-row', local()).filter((entry) => text(one('.chip', entry)) === badge)
  /** 打开一个会话说一句，等这个回合结束 */
  const sayIn = async (badge: string, words: string) => {
    ;(await until(`${badge} 的会话`, () => rowsOf(badge)[0])).click()
    const area = await until('输入框', () => {
      const found = one<HTMLTextAreaElement>('textarea.cmp-text')
      return found && one('.ss-row.sel') ? found : null
    })
    const before = all('.turn').length
    fill(area, words)
    await frame()
    area.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await until('这个回合结束', () => all('.turn').length > before && !one('.running-line'))
  }
  /** 新建会话的选择器里有哪些 harness。看完把选择器收起来 */
  const pickerOptions = async () => {
    ;(
      await until('设备行上的新建按钮', () =>
        one<HTMLButtonElement>('.dev-row ~ .row-add', local()),
      )
    ).click()
    const button = await until('选 harness 的选择器', () =>
      one('.new-hero') ? one<HTMLButtonElement>('.pick[data-kind="harness"] .pick-btn') : null,
    )
    button.click()
    const options = await until('harness 的选项', () => {
      const found = all('.pick[data-kind="harness"] .pick-opt')
      return found.length > 0 ? found : null
    })
    const ids = options.map((option) => option.dataset.option ?? '')
    button.click()
    await until('选择器收起来', () => !one('.pick[data-kind="harness"] .pick-opt'))
    return ids
  }

  // ---- 一、设备页：每台设备都点得开；没有设置接口的、没连上的各是什么样 ----
  await until('侧栏里的会话', () => all('.ss-row').length >= 10)
  one<HTMLButtonElement>('.sb-settings')?.click()
  ;(
    await until('设置页上进设备页的入口', () =>
      one<HTMLButtonElement>('.set-go[data-page="devices"]'),
    )
  ).click()
  await until('设备页', () => all('.devp-item').length >= 4)
  const entries = all('.devp-item').map(
    (item) =>
      `${item.dataset.device}:${all('button', item).length}:${all('input, select, textarea, a', item).length}`,
  )
  const shell = '.mng, .mng-h, .mng-save, [data-sec="diagnostics"], [data-sec="logs"]'
  const plain = await openDetail('nas')
  const plainState = one('[data-manage-state]', plain)?.dataset.manageState ?? ''
  const plainShell = all(shell, plain).length
  const plainFacts = all('.devp-facts > div', plain).length
  const deviceActs = [actsOf(plain)]
  const off = await openDetail('gpu')
  const offlineState = one('[data-manage-state]', off)?.dataset.manageState ?? ''
  const offlineShell = all(shell, off).length
  // 没连上的原因在详情里；对面的原话点“详情”才展开
  one<HTMLButtonElement>('.cfail-acts [aria-expanded="false"]', off)?.click()
  await frame()
  const offlineWhy = `${text(one('.cfail-text', off))}｜${text(one('.cfail-detail', off))}`
  deviceActs.push(actsOf(off))

  // ---- 二、本机：一打开只露一眼要看的；点开之后是 harness、每种类型的控件、密钥、入口的状况 ----
  const page = await openDetail('local')
  await ready()
  deviceActs.push(actsOf(page))
  const foldedShown = [
    '[data-setting]',
    '.mng-h-why',
    '[data-inherited]',
    '[data-ssh-entry]',
    '[data-act="ssh-config"]',
  ]
    .map((selector) => all(selector, page).length)
    .join('/')
  const heads = all('[data-harness-block]').map(
    (entry) =>
      `${entry.dataset.harnessBlock}:${entry.dataset.open}:${
        one('.mng-h-head [data-lead] .switch', entry)?.getAttribute('aria-checked') ?? '没有开关'
      }:${act(one('.mng-h-head', entry), 'restart') ? '有重启' : '没有重启'}`,
  )
  const summaries = [
    `状况：${text(one('[data-sec="ssh"] [data-ssh-failed]', page))}，${text(one('[data-sec="ssh"] .mng-sum', page))}`,
    ...all('[data-sec="group"]', page).map(
      (entry) => `${entry.dataset.group}：${text(one('.mng-sum', entry))}`,
    ),
    `环境文件：${text(one('.env-inherited > .fold .dim', page))}`,
  ]
  const folds = all('.fold', page)
  const foldsReachable =
    folds.length >= 8 &&
    folds.every((fold) => {
      fold.focus()
      return (
        fold.tagName === 'BUTTON' &&
        document.activeElement === fold &&
        fold.getAttribute('aria-expanded') === 'false' &&
        Boolean(one('.caret-ic', fold))
      )
    })
  // 点开不可用的那一个：原因在里面；再点一下收起
  const codexFold = one<HTMLButtonElement>('.fold', block('codex') as HTMLElement)
  codexFold?.click()
  const downReason = text(
    await until('不可用的原因', () => one('.mng-h-why', block('codex') as HTMLElement)),
  )
  const shownOpen = `${block('codex')?.dataset.open}:${codexFold?.getAttribute('aria-expanded')}:${Boolean(
    document.getElementById(codexFold?.getAttribute('aria-controls') ?? ''),
  )}`
  codexFold?.click()
  await until('收起来', () => !one('.mng-h-why', block('codex') as HTMLElement))
  const foldToggles = `${shownOpen}>${block('codex')?.dataset.open}:${codexFold?.getAttribute('aria-expanded')}`
  await unfold()
  const harnesses = all('[data-harness-block]').map(
    (entry) => `${entry.dataset.harnessBlock}:${entry.dataset.state}`,
  )
  const controls: Record<string, string> = {}
  for (const entry of all('[data-setting]')) {
    const type = entry.dataset.type ?? ''
    controls[type] ??= one('.switch', entry)
      ? 'switch'
      : one('select', entry)
        ? 'select'
        : one('.env', entry)
          ? 'env'
          : one('.mng-unknown', entry)
            ? 'readonly'
            : one('input[type="password"]', entry)
              ? 'password'
              : one('.mng-num', entry)
                ? 'number'
                : one('input', entry)
                  ? 'text'
                  : 'none'
  }
  const unknown = row('harness.dsh.wakeSchedule') as HTMLElement
  const unknownNote = text(one('.form-note', one('.mng-unknown', unknown) as HTMLElement))
  const unknownEditable = Boolean(one('input, select, button', unknown))
  const secretShown = text(one('[data-secret-state]', row('harness.pi.apiKey') as HTMLElement))
  const envSecret = one('[data-env="ANTHROPIC_API_KEY"]') as HTMLElement
  const envSecretShown = text(one('.env-kept .pill', envSecret))
  const envSecretHasInput = Boolean(one('.env-value', envSecret))
  const inheritedSecret = text(one('[data-inherited="OPENAI_API_KEY"] .pill'))
  const sshStates = all('[data-ssh-entry]').map(
    (entry) => `${entry.dataset.sshEntry}:${entry.dataset.state}`,
  )
  const sshFailedReason = text(one('[data-ssh-entry][data-state="failed"] .ssh-why'))
  // 切到英文看一眼，再切回来。换语言走界面给验收留的口子，不靠界面上哪个按钮
  const look = (
    window as unknown as {
      __litchLook: {
        get(): { skin: string; theme: string; lang: string }
        set(patch: { skin?: string; theme?: string; lang?: string }): void
      }
    }
  ).__litchLook
  const title = () => text(one('.mng-row-title', row('harness.pi.cliPath') as HTMLElement))
  const chinese = title()
  look.set({ lang: 'en' })
  await until('标题换成英文', () => title() !== chinese)
  const english = title()
  look.set({ lang: 'zh-CN' })
  await until('标题换回中文', () => title() === chinese)

  // ---- 三、停用 Pi（在收着的标题行上拨），再启用（在里面那一行上拨） ----
  const enabled = () => one<HTMLButtonElement>('.switch', row('harness.pi.enabled') as HTMLElement)
  const lead = () =>
    one<HTMLButtonElement>('.mng-h-head [data-lead] .switch', block('pi') as HTMLElement)
  const piFold = () => one<HTMLButtonElement>('.fold', block('pi') as HTMLElement)
  const isDown = (entry: HTMLElement) => entry.classList.contains('down')
  piFold()?.click()
  await until('Pi 收起来', () => block('pi')?.dataset.open === 'false')
  lead()?.click()
  await until('保存条', bar)
  // 有没保存的改动：这一块自己开了，再点收起也收不起来
  await until('Pi 这一块自己开了', () => block('pi')?.dataset.open === 'true' && enabled())
  piFold()?.click()
  await frame()
  const leadOpens = `${block('pi')?.dataset.open}:${lead()?.getAttribute('aria-checked')}:${enabled()?.getAttribute('aria-checked')}`
  const disableBar = dirty()
  await save()
  await until('Pi 变成停用', () => block('pi')?.dataset.state === 'disabled')
  const disabledState = block('pi')?.dataset.state ?? ''
  const pickerWithout = await pickerOptions()
  const stopped = rowsOf('PI')
  const disabledRows = `${stopped.filter(isDown).length}/${stopped.length}`
  stopped[0]?.click()
  const disabledHint = text(await until('输入区说了发不了', () => one('.dock .cmp-hint.err')))
  await openDetail('local')
  await ready()
  await unfold()
  enabled()?.click()
  const leadFollows = Boolean(
    await until('标题行上的开关跟着变', () => lead()?.getAttribute('aria-checked') === 'true'),
  )
  await save()
  await until('Pi 恢复可用', () => block('pi')?.dataset.state === 'ready')
  const enabledState = block('pi')?.dataset.state ?? ''
  const pickerWith = await pickerOptions()
  const enabledRowsDown = rowsOf('PI').filter(isDown).length

  // ---- 四、给 dsh 加两个环境变量（一个普通的、一个密钥），给 Pi 填一个密钥 ----
  await openDetail('local')
  await ready()
  await unfold()
  const env = () => row('harness.dsh.env') as HTMLElement
  const addVariable = async (name: string, value: string) => {
    act(env(), 'env-add')?.click()
    const added = await until('新的一行', () =>
      all('.env-row', env()).find((entry) => entry.dataset.env === ''),
    )
    fill(one<HTMLInputElement>('.env-name', added) as HTMLInputElement, name)
    const field = await until('值的输入框', () =>
      one<HTMLInputElement>(`[data-env="${name}"] .env-value`, env()),
    )
    fill(field, value)
    await frame()
  }
  await addVariable('DSH_REGION', 'cn-east')
  // 名字看着像密钥的不用勾，自己就按密钥来
  await addVariable('DSH_TOKEN', 'sk-PROBE-secret-one')
  fill(input('harness.pi.apiKey') as HTMLInputElement, 'sk-PROBE-secret-two')
  await until('两栏改动', () => dirty() === 2)
  const masked = one<HTMLInputElement>('[data-env="DSH_TOKEN"] .env-value', env())?.type
  await save()
  const savedToast = toast('manage-save:local')
  await until('密钥收成“已设置”', () => one('[data-env="DSH_TOKEN"] .env-kept', env()))
  const envSaved = all('.env-row', env()).map(
    (entry) =>
      `${entry.dataset.env}=${one<HTMLInputElement>('.env-value', entry)?.value ?? text(one('.env-kept .pill', entry))}`,
  )
  const secretRow = row('harness.pi.apiKey') as HTMLElement
  const apiKeyAfter = `${text(one('[data-secret-state]', secretRow))}|${input('harness.pi.apiKey')?.value}|${masked}`
  // 把刚填的密钥找一遍：页面上的字、每个输入框里的值、浏览器的本地存储
  const secretLeaks: string[] = []
  if (document.documentElement.outerHTML.includes('sk-PROBE')) secretLeaks.push('页面')
  if (
    all('input, textarea').some((entry) => (entry as HTMLInputElement).value.includes('sk-PROBE'))
  )
    secretLeaks.push('输入框')
  for (const store of [localStorage, sessionStorage]) {
    for (let index = 0; index < store.length; index++) {
      if ((store.getItem(store.key(index) ?? '') ?? '').includes('sk-PROBE'))
        secretLeaks.push('本地存储')
    }
  }
  await until('dsh 和 Pi 重新起来', () =>
    ['dsh', 'pi'].every((id) => block(id)?.dataset.state === 'ready'),
  )

  // ---- 五、Claude Code 有回合在跑：改它要重启才生效的设置，标成待重启；重启先问 ----
  const claude = () => block('claude') as HTMLElement
  choose(select('harness.claude.logLevel') as HTMLSelectElement, 'debug')
  await save()
  await until('Claude Code 标成待重启', () => claude().dataset.pending === 'true')
  const pendingShown = Boolean(one('[data-pending-pill]', claude()))
  const pendingToast = toast('manage-save:local')
  const confirm = () => one('dialog.confirm[open]')
  act(claude(), 'restart')?.click()
  const asked = await until('重启前的确认框', confirm)
  const confirmTitle = text(one('b', asked))
  one<HTMLButtonElement>('.btn.ghost', asked)?.click()
  await until('确认框收掉', () => !confirm())
  const stillPending = claude().dataset.pending === 'true' && claude().dataset.state === 'ready'
  act(claude(), 'restart')?.click()
  one<HTMLButtonElement>('.confirm-yes', await until('重启前的确认框', confirm))?.click()
  await until(
    'Claude Code 重启完',
    () =>
      claude().dataset.pending === 'false' &&
      claude().dataset.state === 'ready' &&
      claude().dataset.restarting === 'false',
  )
  const restarted = !one('[data-pending-pill]', claude())

  // ---- 六、填得不对：界面自己拦的（超出范围），设备服务不认的（端口和别的入口相同） ----
  const scrollback = () => input('terminal.scrollback') as HTMLInputElement
  const port = () => input('ssh.dsh.port') as HTMLInputElement
  fill(scrollback(), '10')
  const rangeProblem = text(
    await until('范围的提示', () =>
      one('.mng-row-note.err', row('terminal.scrollback') as HTMLElement),
    ),
  )
  const saveBlocked = saveButton()?.disabled === true
  fill(scrollback(), '5000')
  fill(port(), '22230')
  await until('两栏改动，可以保存', () => dirty() === 2 && saveButton()?.disabled === false)
  saveButton()?.click()
  const refused = text(
    await until('设备服务不认的说明', () =>
      one('[data-refused]', row('ssh.dsh.port') as HTMLElement),
    ),
  )
  const refusedKept = dirty()
  fill(port(), '22240')
  await save()
  const fixedSaved = scrollback().value === '5000' && port().value === '22240'

  // ---- 七、别处改了设置：开着的页面跟着变；正在改的那一栏不冲掉，标出来让人选 ----
  const keep = () => select('terminal.keepAlive') as HTMLSelectElement
  const keepRow = () => row('terminal.keepAlive') as HTMLElement
  choose(keep(), 'forever')
  await until('一栏改动', () => dirty() === 1)
  await sayIn('DS', '别处改设置')
  await openDetail('local')
  await ready()
  // 带着没保存的改动回来：有改动的那一节自己开着，别的照旧收着
  await until('有改动的那一栏', keepRow)
  const draftReopened = `${one('[data-sec="group"][data-group="terminal"]')?.dataset.open}:${block('pi')?.dataset.open}`
  await unfold()
  await until('别处的改动到了', () => keepRow().dataset.conflict === 'true', 20_000)
  const elsewhereConflict = text(one('.mng-conflict span', keepRow()))
  const elsewhereMine = keep().value
  const elsewhereOther = port().value
  const elsewhereBlocked = saveButton()?.disabled === true
  act(keepRow(), 'keep-mine')?.click()
  await save()
  const keptMine = `${keep().value}:${keepRow().dataset.dirty}`

  // ---- 八、别处抢先改了、通知没到这边：保存得到冲突，什么都没覆盖 ----
  await sayIn('DS', '抢先改设置')
  await openDetail('local')
  await ready()
  await unfold()
  fill(port(), '22999')
  fill(scrollback(), '7000')
  await until('两栏改动', () => dirty() === 2)
  saveButton()?.click()
  const portRow = () => row('ssh.dsh.port') as HTMLElement
  await until('这一栏标出被别处改过', () => portRow().dataset.conflict === 'true')
  const raceToast = toast('manage-save:local')
  const raceConflict = text(one('.mng-conflict span', portRow())).length > 0
  const other = row('terminal.scrollback') as HTMLElement
  const raceOtherKept =
    other.dataset.dirty === 'true' &&
    other.dataset.conflict === 'false' &&
    scrollback().value === '7000'
  act(portRow(), 'take-latest')?.click()
  await until('这一栏换成最新的', () => portRow().dataset.dirty === 'false')
  const raceLatest = port().value
  await save()
  const raceSaved = `${scrollback().value}:${keep().value}`

  // ---- 九、设备服务多了一项设置：界面没改也看得到、改得了 ----
  await sayIn('DS', '加一项设置')
  await openDetail('local')
  await ready()
  await unfold()
  const added = await until('新加的那一项', () => row('harness.dsh.startupNote'))
  const addedType = `${added.dataset.type}:${text(one('.mng-row-title', added))}`
  fill(input('harness.dsh.startupNote') as HTMLInputElement, '升级之后加的')
  await save()
  const addedSaved = input('harness.dsh.startupNote')?.value ?? ''

  // ---- 十、诊断、日志、ssh 配置片段 ----
  act(document, 'run-diagnostics')?.click()
  const checks = (
    await until('诊断的结果', () => {
      const found = all('[data-check]')
      return found.length > 0 ? found : null
    })
  ).map((entry) => `${entry.dataset.check}:${entry.dataset.status}`)
  const source = one<HTMLSelectElement>('[data-log-source]') as HTMLSelectElement
  choose(source, 'runtime:pi')
  await frame()
  act(document, 'read-log')?.click()
  const logTail = text(
    await until('日志的末尾', () => one('.mng-log[data-log="runtime:pi"] pre')),
  ).length
  const logTruncated = Boolean(one('.mng-log-head .form-note'))
  choose(source, 'diagnostics:pi')
  await frame()
  act(document, 'read-log')?.click()
  const logEmptyNote = Boolean(
    await until('空日志的说明', () =>
      one('.mng-log[data-log="diagnostics:pi"][data-empty="true"] .form-note'),
    ),
  )
  act(document, 'ssh-config')?.click()
  const snippets = await until('配置片段', () => {
    const found = all('[data-ssh-config]')
    return found.length > 0 ? found : null
  })
  const configAvailable = snippets
    .filter((entry) => entry.dataset.available === 'true')
    .map((entry) => entry.dataset.sshConfig ?? '')
  const configUnavailable = text(one('[data-ssh-config="codex"] > .form-note'))
  act(one('[data-ssh-config="claude"]'), 'copy-config')?.click()
  await until('复制到了', () => clipboard.length > 0)
  const copied = clipboard.at(-1) ?? ''

  // ---- 十一、放弃改动，可以撤销 ----
  fill(scrollback(), '9000')
  await until('一栏改动', () => dirty() === 1)
  const steps = [dirty()]
  act(bar(), 'discard')?.click()
  await until('保存条收掉', () => !bar())
  steps.push(dirty())
  one<HTMLButtonElement>('.toast[data-toast="manage-save:local"] .toast-act')?.click()
  await until('改动回来了', () => dirty() === 1 && scrollback().value === '9000')
  steps.push(dirty())
  act(bar(), 'discard')?.click()
  await until('保存条收掉', () => !bar())
  steps.push(dirty())
  const discardUndo = steps.join('>')

  // ---- 十二、远程设备是同一套界面：示例里它一开始就有一个 harness 等着重启 ----
  deviceActs.push(actsOf(await openDetail('build')))
  await ready()
  // 等着重启的那一个，收着的标题行上就看得出
  const remotePending = all('[data-harness-block][data-pending="true"]')
    .filter((entry) => one('.mng-h-head [data-pending-pill]', entry))
    .map((entry) => entry.dataset.harnessBlock ?? '')
  await unfold()

  // ---- 十三、三种皮肤、深浅色：标题、说明、开着的开关、标题行上的名字和摘要，都和底色分得开 ----
  const luminance = (color: string) => {
    const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => {
      const channel = Number(part) / 255
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrast = (a: string, b: string) => {
    const [high = 0, low = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (high + 0.05) / (low + 0.05)
  }
  const style = (selector: string) => getComputedStyle(one(selector) as HTMLElement)
  /** 一个元素底下实际垫着的颜色：自己没有底色就往外找 */
  const backdrop = (selector: string) => {
    for (let node = one(selector); node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor
      if (!/rgba?\(.*,\s*0\)$/.test(color) && color !== 'transparent') return color
    }
    return getComputedStyle(document.body).backgroundColor
  }
  const before = look.get()
  const skins: string[] = []
  for (const skin of ['retro', 'human', 'standard']) {
    for (const theme of ['light', 'dark']) {
      look.set({ skin, theme })
      // 开关换颜色有一小段过渡，等它走完再量
      await sleep(250)
      const card = style('.mng-h').backgroundColor
      const numbers = [
        contrast(style('.mng-row-title').color, card),
        contrast(style('.mng-row .form-note').color, card),
        contrast(style('.switch[aria-checked="true"]').backgroundColor, card),
        contrast(style('.mng-h-name').color, card),
        contrast(style('.mng-sum').color, backdrop('.mng-sum')),
      ]
      skins.push(`${skin}/${theme}:${numbers.map((value) => value.toFixed(1)).join(':')}`)
    }
  }
  look.set({ skin: before.skin, theme: before.theme })

  return {
    entries,
    deviceActs,
    plainState,
    plainShell,
    plainFacts,
    offlineState,
    offlineShell,
    offlineWhy,
    foldedShown,
    heads,
    summaries,
    foldsReachable,
    foldToggles,
    harnesses,
    downReason,
    controls,
    unknownNote,
    unknownEditable,
    secretShown,
    envSecretShown,
    envSecretHasInput,
    inheritedSecret,
    sshStates,
    sshFailedReason,
    english,
    leadOpens,
    disableBar,
    disabledState,
    pickerWithout,
    disabledRows,
    disabledHint,
    leadFollows,
    enabledState,
    pickerWith,
    enabledRowsDown,
    envSaved,
    apiKeyAfter,
    secretLeaks,
    savedToast,
    pendingShown,
    pendingToast,
    confirmTitle,
    stillPending,
    restarted,
    rangeProblem,
    saveBlocked,
    refused,
    refusedKept,
    fixedSaved,
    elsewhereConflict,
    elsewhereMine,
    elsewhereOther,
    elsewhereBlocked,
    keptMine,
    draftReopened,
    raceToast,
    raceConflict,
    raceOtherKept,
    raceLatest,
    raceSaved,
    addedType,
    addedSaved,
    checks,
    logTail,
    logTruncated,
    logEmptyNote,
    configAvailable,
    configUnavailable,
    copied,
    discardUndo,
    remotePending,
    skins,
  }
}
