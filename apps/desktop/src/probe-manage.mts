// 设备与 harness 管理的验收，对着真的设备服务的那一半：隔离设备（scripts/device-fixture.mjs --managed）
// 由真的适配器主进程管着一份 Pi 运行时，聚合面上有设备配置接口。在真的外壳里从详情页走一遍：
// 看到 harness 和状态；别的客户端改了设置，这边跟着变；停用 Pi 再启用；加环境变量和密钥；
// 有请求停着等人时改设置（待重启）并强行重启；空闲时重启；诊断；日志；开关一个 SSH 入口并复制配置片段。
// “别的客户端”是起自检的脚本：页面打一行 LITCH_SIGNAL write <设置项的键>，脚本另开一条连接去改那一项。
// 详情一打开设置都收着：每次进详情先把收着的点开，再去读、去改。
// 对着模拟核心的那一半（各种状态和控件、收起展开本身）在 probe-manage-mock.mts。
// 和别的验收一样，下面的函数会被原样送进页面里执行，不能引用函数外面的东西。

export interface ManageProbe {
  /** 设备列表上本机那一行：标识和里面的按钮数（整行就是那一个） */
  entry: string
  /** 详情一打开：露出来的设置项有几个、harness 的标题行有几行 */
  folded: string
  /** harness 和状态；用不了的那些各自的原因 */
  harnesses: string[]
  downReasons: string[]
  /** 每个 harness 标题行上的启用开关（标识:开着没有）。哪一项是它，认的是设备服务标的角色 */
  leads: string[]
  /** 设备服务声明的设置都画出来了：有哪些类型 */
  settingTypes: string[]
  /** 别的客户端改了两项：没在改的那一栏跟着变；正在改的那一栏不冲掉，标出来，选了“用最新的” */
  liveUpdated: boolean
  conflictShown: string
  conflictMine: boolean
  tookLatest: string
  /** 停用 Pi：状态、它的会话都留着并标成不可用、新建不了、会话里说了发不了 */
  disabledState: string
  disabledRows: string
  newSessionBlocked: string
  /** 新建对话页上那句话后面的细节：各个 harness 是怎么回事、下一步做什么，最后是去“设备”一页的按钮 */
  newSessionWhy: string
  pickerHasPi: boolean
  disabledHint: string
  /** 再启用：恢复，会话照常能发 */
  enabledState: string
  enabledRowsDown: number
  spokeAfterEnable: boolean
  /** 加两个环境变量（一个普通的、一个密钥）：保存后密钥只剩“已设置”，哪儿都找不到它 */
  envSaved: string[]
  secretLeaks: string[]
  savedToast: string
  spokeAfterEnv: boolean
  /** 有请求停着等人时改设置：待重启；重启先问，说了照做才重启 */
  pendingShown: boolean
  confirmTitle: string
  forced: boolean
  /** 空闲时重启 */
  restartToast: string
  restartState: string
  /** 诊断逐项的结果 */
  checks: string[]
  /** 日志的末尾；里面没有刚才填的密钥 */
  deviceLog: number
  runtimeLog: number
  logLeaks: string[]
  /** 打开 Pi 的 SSH 入口：起来了，配置片段复制得到；再关上 */
  sshBefore: string
  sshOn: string
  sshNeededRestart: boolean
  copied: string
  sshOff: string
  /** 这一路上两句摘要跟着变：入口的状况里“几个在监听”、入口那组设置里“开着几个”（打开之前>开着>关上之后） */
  sshListening: string
  sshSwitchesOn: string
}

export async function manageProbe(): Promise<ManageProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 60_000,
  ) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    // 等不到的时候把眼前的提示带上，好知道卡在哪
    const toasts = [...document.querySelectorAll('.toast-text')].map((entry) => entry.textContent)
    throw new Error(`等不到：${what}（提示：${toasts.join('｜') || '没有'}）`)
  }
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
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

  const row = (key: string) => one(`[data-setting="${key}"]`) as HTMLElement
  const input = (key: string) => one<HTMLInputElement>(`[data-setting="${key}"] input`)
  const block = (id: string) => one(`[data-harness-block="${id}"]`) as HTMLElement
  const bar = () => one('.mng-save')
  const saveButton = () => one<HTMLButtonElement>('.mng-save [data-act="save"]')
  const toast = (id: string) => text(one(`.toast[data-toast="${id}"] .toast-text`))
  const act = (root: ParentNode | null, name: string) =>
    root ? one<HTMLButtonElement>(`[data-act="${name}"]`, root) : null
  const save = async () => {
    const button = await until('能按的“保存”', () => {
      const found = saveButton()
      return found && !found.disabled ? found : null
    })
    button.click()
    await until('保存条收掉', () => !bar())
  }
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
  const openDetail = async () => {
    if (!one('[data-detail]')) {
      one<HTMLButtonElement>('.sb-link.devices')?.click()
      const item = await until('设备列表上的本机', () => one('.devp-item[data-device="local"]'))
      one<HTMLButtonElement>('.devp-row', item)?.click()
    }
    await until('管理数据', () => one('[data-manage-state="ready"]'))
    await unfold()
  }
  const piReady = (ms = 60_000) =>
    until(
      'Pi 可用',
      () => block('pi')?.dataset.state === 'ready' && block('pi').dataset.pending === 'false',
      ms,
    )
  const rows = () => all('.ss-row')
  const isDown = (entry: HTMLElement) => entry.classList.contains('down')
  const rowOf = (title: string) => rows().find((entry) => text(one('.title', entry)) === title)
  const area = () => one<HTMLTextAreaElement>('textarea.cmp-text')
  /** 打开一个会话说一句。不等回话 */
  const sayIn = async (title: string, words: string) => {
    ;(await until(`侧栏里的“${title}”`, () => rowOf(title))).click()
    const box = await until('输入框', () =>
      text(one('.crumb b')) === title && one('.turn') ? area() : null,
    )
    fill(box, words)
    await frame()
    box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    )
    await frame()
  }
  /** 说一句，等假模型把话带回来（它会注明是哪个 harness 收到的） */
  const converse = async (title: string, words: string) => {
    await sayIn(title, words)
    await until(
      `“${words}”的回话`,
      () =>
        (all('.turn').at(-1)?.textContent ?? '').includes(`pi 收到：${words}`) &&
        !one('.running-line'),
    )
    return true
  }
  const SESSION = '给列表加上分页'

  // ---- 一、详情页：harness 和状态、设备服务声明的设置 ----
  await until('Pi 的会话都列出来', () => rows().length >= 3)
  one<HTMLButtonElement>('.sb-link.devices')?.click()
  const item = await until('设备列表上的本机', () =>
    one<HTMLElement>('.devp-item[data-device="local"]'),
  )
  const entry = `${item.dataset.device}:${all('button', item).length}`
  one<HTMLButtonElement>('.devp-row', item)?.click()
  await until('管理数据', () => one('[data-manage-state="ready"]'))
  await piReady()
  // 一打开只有 harness 各一行，设置项都收着
  const folded = `${all('[data-setting]').length}/${all('[data-harness-block] .mng-h-head').length}`
  await unfold()
  const harnesses = all('[data-harness-block]').map(
    (item) => `${item.dataset.harnessBlock}:${item.dataset.state}`,
  )
  // 停用了的不写原因（开关就在标题行上），只看一时用不了的
  const downReasons = all('[data-harness-block][data-state="unavailable"]').map((item) =>
    text(one('.mng-h-why', item)),
  )
  const leads = all('[data-harness-block]').map(
    (item) =>
      `${item.dataset.harnessBlock}:${
        one('.mng-h-head [data-lead] .switch', item)?.getAttribute('aria-checked') ?? '没有开关'
      }`,
  )
  const settingTypes = [...new Set(all('[data-setting]').map((item) => item.dataset.type ?? ''))]
    .filter(Boolean)
    .sort()

  // ---- 二、别的客户端改了两项设置：一项这边没在改，一项这边正改着 ----
  const piPort = () => input('ssh.pi.port') as HTMLInputElement
  const otherPort = () => input('ssh.dsh.port') as HTMLInputElement
  const otherBefore = otherPort().value
  const elsewhere = String(Number(piPort().value) + 1)
  const mine = String(Number(piPort().value) + 2)
  fill(piPort(), mine)
  await until('这一栏记成改过', () => row('ssh.pi.port').dataset.dirty === 'true')
  console.log(`LITCH_SIGNAL write ssh.dsh.port ${Number(otherBefore) + 3}`)
  console.log(`LITCH_SIGNAL write ssh.pi.port ${elsewhere}`)
  await until('没在改的那一栏跟着变', () => otherPort().value !== otherBefore, 20_000)
  const liveUpdated = otherPort().value === String(Number(otherBefore) + 3)
  await until(
    '正在改的那一栏标出被别处改过',
    () => row('ssh.pi.port').dataset.conflict === 'true',
    20_000,
  )
  const conflictShown = text(one('.mng-conflict span', row('ssh.pi.port')))
  const conflictMine = piPort().value === mine && saveButton()?.disabled === true
  act(row('ssh.pi.port'), 'take-latest')?.click()
  await until('这一栏换成最新的', () => row('ssh.pi.port').dataset.dirty === 'false')
  const tookLatest = `${piPort().value}:${elsewhere}`

  // ---- 三、停用 Pi ----
  const enabled = () => one<HTMLButtonElement>('.switch', row('harness.pi.enabled'))
  const before = rows().length
  enabled()?.click()
  await save()
  await until('Pi 变成停用', () => block('pi').dataset.state === 'disabled')
  const disabledState = block('pi').dataset.state ?? ''
  // 停用之后核心会重新对一次账：等它对完，会话应该还在
  await sleep(2500)
  const disabledRows = `${rows().filter(isDown).length}/${rows().length}/${before}`
  ;(await until('设备行上的新建按钮', () => one<HTMLButtonElement>('.dev-row ~ .row-add'))).click()
  await until('新建会话的页面', () => one('.new-hero'))
  const newSessionBlocked = text(
    await until('说了建不了', () => one('.dock .cmp-hint.err'), 10_000),
  )
  const why = one('.new-why[data-down="harness"]')
  const newSessionWhy = `${text(one('.new-why-row[data-harness="pi"]', why ?? document))}｜${text(
    one('[data-act="open-devices"]', why ?? document),
  )}`
  one<HTMLButtonElement>('.pick[data-kind="harness"] .pick-btn')?.click()
  await frame()
  const pickerHasPi = Boolean(one('.pick[data-kind="harness"] .pick-opt[data-option="pi"]'))
  rowOf(SESSION)?.click()
  // 这个会话的内容还没读过，运行时又停着：对话的位置上说明为什么读不出来
  const disabledHint = text(
    await until('会话里说了为什么用不了', () =>
      text(one('.crumb b')) === SESSION ? one('.harness-wait, .dock .cmp-hint.err') : null,
    ),
  )

  // ---- 四、再启用 ----
  await openDetail()
  enabled()?.click()
  await save()
  await piReady()
  const enabledState = block('pi').dataset.state ?? ''
  const enabledRowsDown = rows().filter(isDown).length
  const spokeAfterEnable = await converse(SESSION, '启用之后说一句')

  // ---- 五、给 Pi 加两个环境变量：一个普通的，一个密钥 ----
  await openDetail()
  const env = () => row('harness.pi.env')
  const addVariable = async (name: string, value: string) => {
    act(env(), 'env-add')?.click()
    const added = await until('新的一行', () =>
      all('.env-row', env()).find((item) => item.dataset.env === ''),
    )
    fill(one<HTMLInputElement>('.env-name', added) as HTMLInputElement, name)
    const field = await until('值的输入框', () =>
      one<HTMLInputElement>(`[data-env="${name}"] .env-value`, env()),
    )
    fill(field, value)
    await frame()
  }
  const SECRET = 'sk-PROBE-kept-on-device'
  await addVariable('LITCH_PROBE_REGION', 'cn-east')
  await addVariable('LITCH_PROBE_TOKEN', SECRET)
  await save()
  const savedToast = toast('manage-save:local')
  await until('密钥收成“已设置”', () => one('[data-env="LITCH_PROBE_TOKEN"] .env-kept', env()))
  await piReady()
  const envSaved = all('.env-row', env()).map(
    (item) =>
      `${item.dataset.env}=${one<HTMLInputElement>('.env-value', item)?.value ?? text(one('.env-kept .pill', item))}`,
  )
  /** 把刚填的密钥找一遍：页面上的字、每个输入框里的值、浏览器的本地存储 */
  const leaks = () => {
    const found: string[] = []
    if (document.documentElement.outerHTML.includes(SECRET)) found.push('页面')
    if (all('input, textarea').some((item) => (item as HTMLInputElement).value.includes(SECRET)))
      found.push('输入框')
    for (const store of [localStorage, sessionStorage]) {
      for (let index = 0; index < store.length; index++) {
        if ((store.getItem(store.key(index) ?? '') ?? '').includes(SECRET)) found.push('本地存储')
      }
    }
    return found
  }
  const secretLeaks = leaks()
  const spokeAfterEnv = await converse(SESSION, '加了环境变量之后说一句')

  // ---- 六、有请求停着等人时改它要重启才生效的设置：待重启；重启先问 ----
  await sayIn(SESSION, '问我两个问题')
  await until('提问的卡片', () => one('.req'))
  await openDetail()
  await addVariable('LITCH_PROBE_EXTRA', '1')
  await save()
  await until('Pi 标成待重启', () => block('pi').dataset.pending === 'true', 20_000)
  const pendingShown =
    Boolean(one('[data-pending-pill]', block('pi'))) && block('pi').dataset.state === 'ready'
  const confirm = () => one('dialog.confirm[open]')
  act(block('pi'), 'restart')?.click()
  const asked = await until('重启前的确认框', confirm, 20_000)
  const confirmTitle = text(one('b', asked))
  one<HTMLButtonElement>('.confirm-yes', asked)?.click()
  await until('强行重启完', () => block('pi').dataset.restarting === 'false' && !confirm())
  await piReady()
  const forced = !one('[data-pending-pill]', block('pi'))

  // ---- 七、空闲时重启 ----
  act(block('pi'), 'restart')?.click()
  await until('开始重启', () => block('pi').dataset.restarting === 'true', 10_000)
  await until('重启完', () => block('pi').dataset.restarting === 'false')
  const restartToast = toast('manage-restart:local:pi')
  await piReady()
  const restartState = block('pi').dataset.state ?? ''

  // ---- 八、诊断 ----
  act(document, 'run-diagnostics')?.click()
  const checks = (
    await until('诊断的结果', () => {
      const found = all('[data-check]')
      return found.length > 0 ? found : null
    })
  ).map((item) => `${item.dataset.check}:${item.dataset.status}`)

  // ---- 九、日志的末尾 ----
  const source = one<HTMLSelectElement>('[data-log-source]') as HTMLSelectElement
  const readLog = async (which: string) => {
    choose(source, which)
    await frame()
    act(document, 'read-log')?.click()
    const shown = await until(`${which} 的日志`, () => one(`.mng-log[data-log="${which}"]`))
    return text(one('pre', shown))
  }
  const logs = {
    device: await readLog('device'),
    service: await readLog('service'),
    runtime: await readLog('runtime:pi'),
    diagnostics: await readLog('diagnostics:pi'),
  }
  const deviceLog = logs.device.length
  const runtimeLog = logs.runtime.length
  const logLeaks = [
    ...Object.entries(logs).flatMap(([name, body]) => (body.includes(SECRET) ? [name] : [])),
    ...leaks(),
  ]

  // ---- 十、打开 Pi 的 SSH 入口，复制配置片段，再关上 ----
  const entryOf = () => one('[data-ssh-entry="pi"]')?.dataset.state ?? ''
  const sshBefore = entryOf()
  /** 标题后面的两句摘要：入口的状况里有几个在监听，入口那组设置里开着几个 */
  const listeningNow = () => one('[data-sec="ssh"] [data-ssh-listening]')?.dataset.sshListening
  const switchesNow = () =>
    one('.mng-sum', row('ssh.pi.enabled').closest('[data-sec="group"]') as HTMLElement)?.dataset.on
  const listeningSeen = [listeningNow()]
  const switchesSeen = [switchesNow()]
  // 端口在第二步被别处改过：先回到默认值（夹具挑的空闲端口），免得撞上别的程序
  act(row('ssh.pi.port'), 'reset')?.click()
  const sshSwitch = () => one<HTMLButtonElement>('.switch', row('ssh.pi.enabled'))
  sshSwitch()?.click()
  await save()
  await until('入口不再是关着', () => entryOf() !== 'off', 20_000)
  // 运行时是带着“入口关着”起来的：有的版本要它重启一次入口才起得来
  let sshNeededRestart = false
  try {
    await until('入口在监听', () => entryOf() === 'listening', 8000)
  } catch {
    sshNeededRestart = true
    act(block('pi'), 'restart')?.click()
    await until('入口在监听', () => entryOf() === 'listening')
  }
  const sshOn = entryOf()
  listeningSeen.push(listeningNow())
  switchesSeen.push(switchesNow())
  act(document, 'ssh-config')?.click()
  const snippet = await until('Pi 入口的配置片段', () =>
    one('[data-ssh-config="pi"][data-available="true"]'),
  )
  act(snippet, 'copy-config')?.click()
  await until('复制到了', () => clipboard.length > 0)
  const copied = clipboard.at(-1) ?? ''
  await piReady()
  sshSwitch()?.click()
  await save()
  await until('入口关上', () => entryOf() === 'off', 20_000)
  const sshOff = entryOf()
  listeningSeen.push(listeningNow())
  switchesSeen.push(switchesNow())
  const sshListening = listeningSeen.join('>')
  const sshSwitchesOn = switchesSeen.join('>')

  return {
    entry,
    folded,
    harnesses,
    downReasons,
    leads,
    settingTypes,
    liveUpdated,
    conflictShown,
    conflictMine,
    tookLatest,
    disabledState,
    disabledRows,
    newSessionBlocked,
    newSessionWhy,
    pickerHasPi,
    disabledHint,
    enabledState,
    enabledRowsDown,
    spokeAfterEnable,
    envSaved,
    secretLeaks,
    savedToast,
    spokeAfterEnv,
    pendingShown,
    confirmTitle,
    forced,
    restartToast,
    restartState,
    checks,
    deviceLog,
    runtimeLog,
    logLeaks,
    sshBefore,
    sshOn,
    sshNeededRestart,
    copied,
    sshOff,
    sshListening,
    sshSwitchesOn,
  }
}
