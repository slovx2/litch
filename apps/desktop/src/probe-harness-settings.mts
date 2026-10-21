// harness 详情设置的验收，对着模拟核心（示例数据在 packages/core/src/mock/mock-harness-config.mts）：
// 从设备详情里 harness 那一行的“详情设置”进去，真的点：
// 一、配置：改开关和整数（填错了保存不了）、保存后写进去；只读项、被盖住的项有说明；
//    别的客户端抢先改了（聊天里说“抢先改配置”）：保存撞上冲突、改动留着、再存就成；
//    改着的时候别处改了（“别处改配置”）：提示一句，用最新的；
// 二、账号：本机 Claude 粘贴授权码（错的没成、对的成了）、切换在用的 provider 要重启、就地重启；
//    远程 build-01 上 Codex：浏览器登录先经 ssh 转发回调端口再成、设备码、API key（错的、对的）、
//    只认环境变量的写进设备设置、按模板加一个自定义 provider 再删掉；配置里要确认的动作；
// 三、MCP：加一个本地命令的（带密钥环境变量）、关掉一个、删掉加的那个、远程服务的 OAuth 授权；
// 四、指令文件：改了保存；统一模式选底稿、确认会被换掉的文件、统一、再退出。
// 浏览器授权页不点开（会真的开系统浏览器），只看地址和转发的状态。
// 和别的验收一样，harnessSettingsProbe 会被原样送进页面里执行，不能引用函数外面的东西；
// judgeHarnessSettings 在主进程里跑。

export interface HarnessSettingsProbe {
  /** 本机设备上带“详情设置”入口的 harness */
  entries: string[]
  /** build-01 上声明里没有详情设置的 dsh：有没有入口、点开后的说明 */
  unsupportedEntry: boolean
  unsupportedNote: string
  /** 配置：开关改了、整数填错时的提示和保存按钮、存完之后 */
  badNumber: string
  saveBlocked: boolean
  saved: { fast: string; days: string; written: string }
  readOnly: boolean
  overridden: string
  /** 抢先改：第一次保存的结果、改动还在不在、再存之后 */
  conflict: string
  keptAfterConflict: number
  resaved: string
  /** 别处改：提示、用最新的之后 */
  moved: boolean
  tookLatest: boolean
  /** 账号（本机 Claude）：粘贴授权码错的、对的；切换 provider 后的重启提示、重启后 */
  pasteFailed: string
  pasteDone: string
  restartBanner: boolean
  restartCleared: boolean
  /** 账号（build-01 的 Codex）：浏览器登录时看到的转发状态和端口、最后一步；设备码；API key */
  forwardStates: string[]
  forwardText: string
  browserDone: string
  userCode: string
  deviceDone: string
  apiKeyFailed: string
  apiKeyDone: string
  /** 环境变量方式写完的提示 */
  envToast: string
  /** 改用自定义的 provider 之后在用的是哪个 */
  activeAfter: string
  /** 按模板加的 provider：加上了、删掉了 */
  customAdded: string
  customRemoved: boolean
  /** 配置里要确认的动作：确认框上的字、做完的提示 */
  actionConfirm: string
  actionToast: string
  /** MCP：加上的那一行、密钥变量、关掉之后、删掉之后、OAuth 的步骤 */
  mcpAdded: string
  mcpDisabled: string
  mcpRemoved: boolean
  mcpLogin: string
  /** 指令文件：保存前后的哈希、统一前列出的会被换掉的文件数、统一后、退出后 */
  instrHash: [string, string]
  replaced: number
  unified: string
  unifiedEntries: string
  separated: string
}

export async function harnessSettingsProbe(): Promise<HarnessSettingsProbe> {
  const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
  const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))
  const one = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document) =>
    root.querySelector<E>(selector)
  const all = (selector: string, root: ParentNode = document) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
  const text = (element: Element | null | undefined) => element?.textContent?.trim() ?? ''
  const until = async <T,>(
    what: string,
    check: () => T | null | undefined | false,
    ms = 20_000,
  ): Promise<T> => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      const value = check()
      if (value) return value
      await sleep(16)
    }
    const last = check()
    if (last) return last
    throw new Error(`详情设置的验收：等不到${what}（页面上是 ${text(one('.main')).slice(0, 400)}）`)
  }
  /** 往受控的输入框里填字：经原生的写值口子写，再发一个 input，React 才认 */
  const fill = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto =
      field instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const click = async (what: string, find: () => HTMLElement | null) => {
    const button = await until(what, () => {
      const found = find()
      return found && !(found as HTMLButtonElement).disabled ? found : null
    })
    button.click()
    await frame()
  }
  const act = (name: string, root: ParentNode = document) =>
    one<HTMLButtonElement>(`[data-act="${name}"]`, root)

  /** 回到设备列表，点开一台设备的详情 */
  const openDetail = async (deviceId: string) => {
    if (one('.hc-page')) act('hc-back')?.click()
    await frame()
    if (one('[data-detail]'))
      act('back')?.click()
      // 一开始侧栏可能还没画出来：等到齿轮再点
    ;(await until('侧栏的齿轮', () => one<HTMLButtonElement>('.sb-settings'))).click()
    ;(
      await until('设置页上进设备页的入口', () =>
        one<HTMLButtonElement>('.set-go[data-page="devices"]'),
      )
    ).click()
    const item = await until(`设备列表上的 ${deviceId}`, () =>
      one('[data-detail]') ? null : one(`.devp-item[data-device="${deviceId}"]`),
    )
    one<HTMLButtonElement>('.devp-row', item)?.click()
    return until(`${deviceId} 的详情`, () => one(`[data-detail="${deviceId}"]`))
  }
  /** 打开一台设备上一个 harness 的详情设置，切到一个标签，等那一块读到 */
  const openSettings = async (deviceId: string, harness: string, tab = 'config') => {
    await openDetail(deviceId)
    await click(`${harness} 的“详情设置”`, () =>
      act('harness-settings', one(`[data-harness-block="${harness}"]`) ?? document),
    )
    await until(`${harness} 的详情设置页`, () =>
      one(`.hc-page[data-hc="${harness}"][data-hc-device="${deviceId}"] .hc-tabs`),
    )
    one<HTMLButtonElement>(`.hc-tabs [data-tab="${tab}"]`)?.click()
    return until(`${tab} 这一块`, () => one<HTMLElement>(`[data-hc-tab="${tab}"]`))
  }
  /** 本机侧栏里某个 harness 的会话（按徽标认）里说一句，等这个回合结束 */
  const sayIn = async (badge: string, words: string) => {
    const local = one('.dev-group') as HTMLElement
    const row = await until(`${badge} 的会话`, () =>
      all('.ss-row', local).find((entry) => text(one('.chip', entry)) === badge),
    )
    row.click()
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
  const row = (key: string) => one(`[data-hc-key="${key}"]`)
  const bar = () => one('[data-hc-save]')
  const save = async () => {
    await click('能按的“保存”', () => act('hc-save'))
    try {
      await until('保存条收掉', () => !bar(), 10_000)
    } catch {
      throw new Error(`详情设置的验收：保存条没收掉：${text(bar())}`)
    }
  }
  /** 对话框里按“确定”，等它关掉 */
  const submitDialog = async (kind: string) => {
    const dialog = await until(`对话框 ${kind}`, () => one(`[data-hc-dialog="${kind}"]`))
    await click(`${kind} 的确定`, () => act('hc-dialog-yes', dialog))
    await until(`${kind} 关掉`, () => !one(`[data-hc-dialog="${kind}"]`))
  }
  const confirmYes = async () => {
    await click('确认框里的确定', () => one<HTMLButtonElement>('dialog.confirm[open] .confirm-yes'))
  }
  const card = (provider: string) => one(`[data-hc-provider="${provider}"]`)
  /** 一张卡下面的登录，走到 kind 这一步 */
  const stepOf = (root: () => Element | null, kinds: string[]) =>
    until(`登录走到 ${kinds.join('/')}`, () => {
      const found = one<HTMLElement>('[data-hc-attempt]', root() ?? document.createElement('div'))
      return found && kinds.includes(found.dataset.step ?? '') ? found : null
    })
  const dismiss = async (root: () => Element | null) => {
    await click('“知道了”', () => act('hc-auth-dismiss', root() ?? document))
    await until('登录那一块收掉', () => !one('[data-hc-attempt]', root() ?? document))
  }
  const toastText = () => all('.toast').map(text).join(' | ')

  // ---------- 入口 ----------
  await openDetail('local')
  await until('harness 那几块', () => all('[data-harness-block]').length >= 3)
  const entries = all('[data-harness-block]')
    .filter((block) => act('harness-settings', block))
    .map((block) => block.dataset.harnessBlock ?? '')
  // build-01 上的 dsh 还不支持：没有入口，点开那一块说一句
  await openDetail('build')
  const dsh = await until('build-01 上 dsh 那一块', () => one('[data-harness-block="dsh"]'))
  const unsupportedEntry = act('harness-settings', dsh) !== null
  if (one('.fold[aria-expanded="false"]', dsh)) one<HTMLButtonElement>('.fold', dsh)?.click()
  const unsupportedNote = text(
    await until('“还不支持”的说明', () => one('[data-hc-unsupported]', dsh)),
  )

  // ---------- 一、配置（本机 Claude Code） ----------
  await openSettings('local', 'claude')
  const switchOf = (key: string) =>
    one<HTMLButtonElement>('button[role="switch"]', row(key) ?? document)
  const fastBefore = switchOf('fastMode')?.getAttribute('aria-checked')
  switchOf('fastMode')?.click()
  const days = await until('保留天数的输入框', () =>
    one<HTMLInputElement>('input', row('cleanupPeriodDays') ?? document),
  )
  fill(days, '0')
  const badNumber = text(
    await until('填错的提示', () => one('.mng-row-note.err', row('cleanupPeriodDays') ?? document)),
  )
  const saveBlocked = act('hc-save')?.disabled === true
  fill(days, '45')
  await save()
  const saved = {
    fast: `${fastBefore}→${switchOf('fastMode')?.getAttribute('aria-checked')}`,
    days: one<HTMLInputElement>('input', row('cleanupPeriodDays') ?? document)?.value ?? '',
    written: row('fastMode')?.dataset.written ?? '',
  }
  const readOnly = one<HTMLTextAreaElement>('textarea', row('hooks') ?? document)?.disabled === true
  const overridden = text(one('[data-hc-overridden]', row('model') ?? document))

  // 别的客户端抢先改了：第一次保存撞上冲突，改动留着，再存就成
  await sayIn('CC', '抢先改配置')
  await openSettings('local', 'claude')
  switchOf('autoMemoryEnabled')?.click()
  await click('能按的“保存”', () => act('hc-save'))
  const conflict = (
    await until('冲突的说明', () => one<HTMLElement>('[data-hc-failure]', bar() ?? document))
  ).dataset.hcFailure as string
  const keptAfterConflict = Number(bar()?.dataset.dirtyCount ?? 0)
  await save()
  const resaved = switchOf('autoMemoryEnabled')?.getAttribute('aria-checked') ?? ''

  // 改着的时候别处改了：提示一句，用最新的
  await sayIn('CC', '别处改配置')
  await openSettings('local', 'claude')
  switchOf('autoCompactEnabled')?.click()
  const moved = (await until('“别处改过了”的提示', () => one('[data-hc-moved]'))) !== null
  await click('“用最新的”', () => act('hc-take-latest'))
  const tookLatest = (await until('改动放弃、保存条收掉', () => !bar())) === true

  // ---------- 二、账号（本机 Claude Code）：粘贴授权码；切换 provider 要重启 ----------
  await openSettings('local', 'claude', 'accounts')
  const consoleCard = () => card('console')
  await click('Console 的登录', () =>
    one<HTMLButtonElement>('[data-act="hc-method"]', consoleCard() ?? document),
  )
  let attempt = await stepOf(consoleCard, ['openUrl', 'prompt'])
  fill(await until('授权码输入框', () => one<HTMLInputElement>('input', attempt)), 'bad')
  await click('交上授权码', () => act('hc-auth-send', attempt))
  const pasteFailed = text(await stepOf(consoleCard, ['failed']))
  await dismiss(consoleCard)
  await click('再登一次', () =>
    one<HTMLButtonElement>('[data-act="hc-method"]', consoleCard() ?? document),
  )
  attempt = await stepOf(consoleCard, ['openUrl', 'prompt'])
  fill(await until('授权码输入框', () => one<HTMLInputElement>('input', attempt)), 'code#state')
  await click('交上授权码', () => act('hc-auth-send', attempt))
  const pasteDone = text(await stepOf(consoleCard, ['done']))
  await dismiss(consoleCard)
  await click('改用 Console', () => act('hc-provider-activate', consoleCard() ?? document))
  await until('Console 在用', () => consoleCard()?.dataset.active === 'true')
  const restartBanner = (await until('要重启的提示', () => one('[data-hc-restart]'))) !== null
  await click('就地重启', () => act('hc-restart'))
  // 示例里本机的 Claude 有回合在跑：问一声，照样重启
  const busy = await until('重启的结果或者“有回合在跑”', () =>
    one('dialog.confirm[open]') ? 'busy' : !one('[data-hc-restart]') ? 'done' : null,
  )
  if (busy === 'busy') await confirmYes()
  const restartCleared = (await until('重启后提示收掉', () => !one('[data-hc-restart]'))) === true

  // ---------- 二、账号（build-01 的 Codex）：浏览器登录经转发、设备码、API key、环境变量、自定义 provider ----------
  await openSettings('build', 'codex', 'accounts')
  const openai = () => card('openai')
  const method = (id: string) => () =>
    one<HTMLButtonElement>(`[data-act="hc-method"][data-method="${id}"]`, openai() ?? document)
  await click('用 ChatGPT 登录（浏览器）', method('chatgpt-browser'))
  attempt = await stepOf(openai, ['openUrl'])
  const forwardStates: string[] = []
  const forwardEnd = performance.now() + 15_000
  while (performance.now() < forwardEnd) {
    const state = one('[data-hc-forward]', openai() ?? document)?.dataset.hcForward
    if (state && forwardStates.at(-1) !== state) forwardStates.push(state)
    if (state === 'ready') break
    await sleep(16)
  }
  const forwardText = text(one('[data-hc-forward]', openai() ?? document))
  const browserDone = text(await stepOf(openai, ['done', 'failed']))
  await dismiss(openai)
  await click('用 ChatGPT 登录（设备码）', method('chatgpt-device'))
  const code = await stepOf(openai, ['deviceCode'])
  const userCode = text(one('[data-hc-user-code]', code))
  const deviceDone = text(await stepOf(openai, ['done', 'failed']))
  await dismiss(openai)
  const apiKey = async (value: string) => {
    await click('用 API key', method('api-key'))
    const dialog = await until('填 key 的对话框', () => one('[data-hc-dialog="method-apiKey"]'))
    fill(await until('key 的输入框', () => one<HTMLInputElement>('input', dialog)), value)
    await submitDialog('method-apiKey')
    const result = text(await stepOf(openai, ['done', 'failed']))
    await dismiss(openai)
    return result
  }
  const apiKeyFailed = await apiKey('not-a-key')
  const apiKeyDone = await apiKey('sk-probe-1234')

  // 只认环境变量的：写进设备设置
  const litellm = () => card('litellm')
  await click('LITELLM_API_KEY', () =>
    one<HTMLButtonElement>('[data-act="hc-method"][data-kind="env"]', litellm() ?? document),
  )
  const envDialog = await until('环境变量的对话框', () => one('[data-hc-dialog="method-env"]'))
  fill(
    await until('值的输入框', () => one<HTMLInputElement>('input', envDialog)),
    'sk-litellm-probe',
  )
  await submitDialog('method-env')
  const envToast = await until('写完的提示', () =>
    toastText().includes('LITELLM_API_KEY') ? toastText() : null,
  )
  // 写进设备设置会让 Codex 重启一下，重启那一会儿切换不了（提示一句没成）：像人一样过一会儿再点
  for (let round = 0; round < 6 && litellm()?.dataset.active !== 'true'; round++) {
    await click('改用公司网关', () => act('hc-provider-activate', litellm() ?? document))
    await until('公司网关在用', () => litellm()?.dataset.active === 'true', 2000).catch(() => null)
  }
  await until('公司网关在用', () => litellm()?.dataset.active === 'true')
  const activeAfter = all('[data-hc-provider][data-active="true"]')
    .map((element) => element.dataset.hcProvider)
    .join(',')

  // 按模板加一个自定义 provider，再删掉
  await click('添加自定义 provider', () => act('hc-provider-add'))
  const providerDialog = await until('自定义 provider 的对话框', () =>
    one('[data-hc-dialog="provider"]'),
  )
  fill(one<HTMLInputElement>('#hc-provider-id', providerDialog) as HTMLInputElement, 'probe-gw')
  fill(one<HTMLInputElement>('#hc-def-name', providerDialog) as HTMLInputElement, 'Probe Gateway')
  fill(
    one<HTMLInputElement>('#hc-def-base_url', providerDialog) as HTMLInputElement,
    'https://gw.example.com/v1',
  )
  fill(one<HTMLInputElement>('#hc-def-env_key', providerDialog) as HTMLInputElement, 'PROBE_GW_KEY')
  await submitDialog('provider')
  const customAdded = text(await until('加上的 provider', () => card('probe-gw')))
  await click('删掉它', () => act('hc-provider-remove', card('probe-gw') ?? document))
  await confirmYes()
  const customRemoved = (await until('删掉了', () => !card('probe-gw'))) === true

  // 配置里要先确认的动作
  one<HTMLButtonElement>('.hc-tabs [data-tab="config"]')?.click()
  await click('“清空记忆”', () => one<HTMLButtonElement>('[data-hc-action="memory.reset"] button'))
  const actionConfirm = text(await until('确认框', () => one('dialog.confirm[open]')))
  await confirmYes()
  const actionToast = await until('做完的提示', () =>
    toastText().includes('清空记忆') ? toastText() : null,
  )

  // ---------- 三、MCP（本机 Claude Code） ----------
  await openSettings('local', 'claude', 'mcp')
  const server = (name: string) => one(`[data-hc-mcp="${name}"]`)
  await click('添加 MCP 服务', () => act('hc-mcp-add'))
  const mcpDialog = await until('MCP 的对话框', () => one('[data-hc-dialog="mcp"]'))
  one<HTMLButtonElement>('[data-transport="stdio"]', mcpDialog)?.click()
  await frame()
  fill(one<HTMLInputElement>('#hc-mcp-name', mcpDialog) as HTMLInputElement, 'probe-echo')
  fill(one<HTMLInputElement>('#hc-mcp-command', mcpDialog) as HTMLInputElement, 'npx')
  fill(
    one<HTMLTextAreaElement>('#hc-mcp-args', mcpDialog) as HTMLTextAreaElement,
    '-y\nprobe-echo@1.0.0',
  )
  await click('加一个变量', () => act('hc-env-add', mcpDialog))
  const envRow = await until('变量那一行', () => one('[data-hc-env="0"]', mcpDialog))
  const [envName, envValue] = all('input:not([type="checkbox"])', envRow) as HTMLInputElement[]
  fill(envName as HTMLInputElement, 'PROBE_TOKEN')
  fill(envValue as HTMLInputElement, 'secret-probe')
  one<HTMLInputElement>('input[type="checkbox"]', envRow)?.click()
  await frame()
  await submitDialog('mcp')
  const mcpAdded = text(await until('加上的服务', () => server('probe-echo')))
  await click('关掉 playwright', () => act('hc-mcp-toggle', server('playwright') ?? document))
  const mcpDisabled = (
    await until('playwright 关掉了', () =>
      server('playwright')?.dataset.enabled === 'false' ? server('playwright') : null,
    )
  ).dataset.enabled as string
  await click('删掉 probe-echo', () => act('hc-mcp-remove', server('probe-echo') ?? document))
  await confirmYes()
  const mcpRemoved = (await until('probe-echo 删掉了', () => !server('probe-echo'))) === true
  await click('给 sentry 授权', () => act('hc-mcp-login', server('sentry') ?? document))
  const sentry = () => server('sentry')
  const mcpSteps = [(await stepOf(sentry, ['openUrl'])).dataset.step]
  mcpSteps.push((await stepOf(sentry, ['done', 'failed'])).dataset.step)
  const mcpLogin = mcpSteps.join('→')
  await dismiss(sentry)

  // ---------- 四、指令文件（本机）：改了保存；统一模式 ----------
  const instr = await openSettings('local', 'claude', 'instructions')
  const before = instr.dataset.hash ?? ''
  const editor = await until('编辑器', () => one<HTMLTextAreaElement>('[data-hc-editor]'))
  fill(editor, `${editor.value}\n- 验收加的一行\n`)
  await click('保存指令文件', () => act('hc-instr-save'))
  const after = (
    await until('哈希变了', () => {
      const tab = one<HTMLElement>('[data-hc-tab="instructions"]')
      return tab && tab.dataset.hash !== before ? tab : null
    })
  ).dataset.hash as string
  await until('统一模式那一节读到', () => one('[data-hc-unify="off"] [data-act="hc-unify"]'))
  await click('统一成一份', () => act('hc-unify'))
  const unifyDialog = await until('统一的对话框', () => one('[data-hc-dialog="unify"]'))
  const source = one<HTMLSelectElement>('#hc-unify-source', unifyDialog)
  if (source && source.value !== 'claude') {
    source.value = 'claude'
    source.dispatchEvent(new Event('change', { bubbles: true }))
    await frame()
  }
  const replaced = Number(
    (await until('会被换掉的文件', () => one<HTMLElement>('[data-hc-replaced]', unifyDialog)))
      .dataset.hcReplaced,
  )
  await click('统一', () => act('hc-dialog-yes', unifyDialog))
  if (replaced > 0) await confirmYes()
  const unified = text(
    await until('统一好了', () => one('[data-hc-unify="on"] [data-hc-unified]'), 20_000),
  )
  const unifiedEntries = all('[data-hc-entry]')
    .map((entry) => `${entry.dataset.hcEntry}:${text(one('.dim', entry))}`)
    .join(' | ')
  await click('退出统一模式', () => act('hc-separate'))
  await confirmYes()
  await until('退出了', () => one('[data-hc-unify="off"]'))
  const separated = await until('退出的提示', () =>
    toastText().includes('退出统一模式') ? toastText() : null,
  )
  act('hc-back')?.click()

  return {
    entries,
    unsupportedEntry,
    unsupportedNote,
    badNumber,
    saveBlocked,
    saved,
    readOnly,
    overridden,
    conflict,
    keptAfterConflict,
    resaved,
    moved,
    tookLatest,
    pasteFailed,
    pasteDone,
    restartBanner,
    restartCleared,
    forwardStates,
    forwardText,
    browserDone,
    userCode,
    deviceDone,
    apiKeyFailed,
    apiKeyDone,
    envToast,
    activeAfter,
    customAdded,
    customRemoved,
    actionConfirm,
    actionToast,
    mcpAdded,
    mcpDisabled,
    mcpRemoved,
    mcpLogin,
    instrHash: [before, after],
    replaced,
    unified,
    unifiedEntries,
    separated,
  }
}

export function judgeHarnessSettings(seen: HarnessSettingsProbe): string[] {
  const failed: string[] = []
  const must = (ok: boolean, what: string) => {
    if (!ok) failed.push(what)
  }
  for (const id of ['claude', 'codex', 'pi', 'dsh']) {
    must(seen.entries.includes(id), `本机的 ${id} 没有“详情设置”入口：${seen.entries.join('、')}`)
  }
  must(!seen.unsupportedEntry, 'build-01 上还不支持的 dsh 也有“详情设置”入口')
  must(
    seen.unsupportedNote.includes('还不支持'),
    `还不支持的 harness 没有说明：“${seen.unsupportedNote}”`,
  )
  must(seen.badNumber.includes('范围'), `保留天数填 0 没有提示超出范围：“${seen.badNumber}”`)
  must(seen.saveBlocked, '填错了还能按保存')
  must(seen.saved.fast === 'false→true', `快速模式没存成开：${seen.saved.fast}`)
  must(seen.saved.days === '45', `保留天数没存成 45：${seen.saved.days}`)
  must(seen.saved.written === 'true', '存完之后快速模式不算写过')
  must(seen.readOnly, 'hooks 这一项没有只读')
  must(seen.overridden.includes('ANTHROPIC_MODEL'), `被盖住的模型没有说明：“${seen.overridden}”`)
  must(seen.conflict === 'conflict', `抢先改了之后第一次保存不是冲突：${seen.conflict}`)
  must(seen.keptAfterConflict === 1, `冲突之后改动没留着：${seen.keptAfterConflict}`)
  must(seen.resaved === 'false', `冲突之后再存没存成：自动记忆是 ${seen.resaved}`)
  must(seen.moved && seen.tookLatest, '别处改了没有提示，或者“用最新的”没放弃改动')
  must(seen.pasteFailed.includes('没登录成'), `错的授权码没有说没成：“${seen.pasteFailed}”`)
  must(seen.pasteDone.includes('登录好了'), `对的授权码没有登录好：“${seen.pasteDone}”`)
  must(
    seen.restartBanner && seen.restartCleared,
    '切换 provider 之后没有重启提示，或者重启后没收掉',
  )
  must(
    seen.forwardStates.includes('ready') && seen.forwardStates[0] === 'opening',
    `浏览器登录的转发状态不对：${seen.forwardStates.join('→')}`,
  )
  must(seen.forwardText.includes('1455'), `转发的说明里没有端口：“${seen.forwardText}”`)
  must(seen.browserDone.includes('登录好了'), `浏览器登录最后没成：“${seen.browserDone}”`)
  must(seen.userCode === 'WDJB-MJHT', `设备码不对：“${seen.userCode}”`)
  must(seen.deviceDone.includes('登录好了'), `设备码登录最后没成：“${seen.deviceDone}”`)
  must(seen.apiKeyFailed.includes('没登录成'), `错的 API key 没有说没成：“${seen.apiKeyFailed}”`)
  must(seen.apiKeyDone.includes('登录好了'), `对的 API key 没成：“${seen.apiKeyDone}”`)
  must(seen.envToast.includes('LITELLM_API_KEY'), `环境变量写完没有提示：“${seen.envToast}”`)
  must(seen.activeAfter === 'litellm', `改用公司网关之后在用的是：${seen.activeAfter}`)
  must(seen.customAdded.includes('Probe Gateway'), `自定义 provider 没加上：“${seen.customAdded}”`)
  must(seen.customRemoved, '自定义 provider 没删掉')
  must(seen.actionConfirm.includes('清空'), `清空记忆之前没有确认：“${seen.actionConfirm}”`)
  must(seen.actionToast.includes('做完了'), `清空记忆没有做完的提示：“${seen.actionToast}”`)
  must(seen.mcpAdded.includes('probe-echo@1.0.0'), `MCP 服务没加上：“${seen.mcpAdded}”`)
  must(seen.mcpDisabled === 'false', 'playwright 没关掉')
  must(seen.mcpRemoved, 'probe-echo 没删掉')
  must(seen.mcpLogin === 'openUrl→done', `MCP 授权的步骤不对：${seen.mcpLogin}`)
  must(
    seen.instrHash[0] !== '' && seen.instrHash[0] !== seen.instrHash[1],
    `指令文件保存后哈希没变：${seen.instrHash.join(' → ')}`,
  )
  must(seen.replaced >= 1, `统一前没列出会被换掉的文件：${seen.replaced}`)
  must(seen.unified.includes('CLAUDE.md'), `统一之后没说都指向谁：“${seen.unified}”`)
  must(seen.unifiedEntries.includes('指向'), `统一之后各家没有指向底稿：${seen.unifiedEntries}`)
  must(seen.separated.includes('退出统一模式'), `退出统一模式没有提示：“${seen.separated}”`)
  return failed
}
