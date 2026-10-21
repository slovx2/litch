// 设置页“内置浏览器”“Computer Use”两组和设备详情里 Computer Use 开关旁那一句的验收（设置页验收头一遍的一段）。
// 只对着模拟核心；Computer Use 的权限是假的（自检时主进程不去拉起助手，LITCH_COMPUTER_USE_PERMISSIONS 没给就当作
// 两项都没给，见 computer-use/settings.mts），“打开系统设置”“重启助手”在这里点了也只是当作做了，不碰系统设置。
// 浏览数据是这一遍临时用户数据目录里的那一份，真的清。
import type { SettingsKit } from './probe-settings-kit.mjs'

export interface ToolsSeen {
  /** 这个窗口里有没有 Computer Use 的接口（只有 macOS 上的外壳有） */
  computerBridge: boolean
  browser: {
    /** 一直允许的网站那一块的样子（loading、failed、empty、list） */
    sites: string
    /** 点“清除浏览数据”先出确认框；取消就没清；确认之后出“已清除”的提示 */
    confirmShown: boolean
    cancelKeptQuiet: boolean
    clearedToast: boolean
    /** 信任所有网站：开之前、开之后的样子，开着时有没有黑名单 */
    trustBefore: string
    trustAfter: string
    blocklistWhenOff: boolean
    /** 写了一个带协议和大写的网址，加进去的那一行（主机名） */
    blockedRow: string
    /** 认不出的写法出了提示、没加进去 */
    badRefused: boolean
    /** 外壳那边记下来的（加完一项时） */
    stored: { trustAll: boolean; blocked: string[] } | null
    /** 删掉那一项后列表空了；关掉开关后黑名单收起、外壳那边也关了 */
    removedEmpty: boolean
    offHidden: boolean
    storedOff: boolean
  }
  computer: {
    /** 权限那一块：ready、failed、idle、loading */
    perms: string
    /** 每项权限的样子 */
    rows: Record<string, string>
    openButtons: number
    restartShown: boolean
    /** 点了“重启助手”之后还是好好的 */
    restartedOk: boolean
    apps: string
    /** 去设备页的按钮 */
    toDevices: boolean
  } | null
  devices: {
    /** 本机设备 Computer Use 开关下面那一句：missing、unknown、none（没出） */
    localHint: string
    /** 点“去设置里看看”到了设置页的 Computer Use 那一组 */
    linkLands: string
    /** 远程设备的说明里写着操作的是面前的这台电脑（macOS、Windows 一个说法） */
    remoteSaysThisMac: boolean
  }
}

export async function toolsSeen(): Promise<ToolsSeen> {
  const kit = (window as unknown as { __setKit: SettingsKit }).__setKit
  const { until, seen, one, all, text } = kit
  const computerBridge = Boolean(
    (window as unknown as { litchComputerUse?: unknown }).litchComputerUse,
  )

  // ---- 内置浏览器 ----
  await kit.openSettings('browser')
  const sitesBlock = await until('一直允许的网站取到', () => {
    const block = one('.set-content [data-sites]')
    return block && block.dataset.sites !== 'loading' ? block : null
  })
  const sites = sitesBlock.dataset.sites ?? ''
  const clear = () => one<HTMLButtonElement>('.set-content [data-act="clear-data"]')
  clear()?.click()
  const confirmShown = await seen(() => one('dialog.confirm[open]'), 3000)
  one<HTMLButtonElement>('dialog.confirm[open] .btn.ghost')?.click()
  const cancelKeptQuiet =
    (await seen(() => !one('dialog.confirm[open]'), 3000)) &&
    !(await seen(() => text(one('.toasts')).includes('已清除'), 400))
  clear()?.click()
  await until('确认框', () => one('dialog.confirm[open]'))
  one<HTMLButtonElement>('dialog.confirm[open] .confirm-yes')?.click()
  const clearedToast = await seen(() => text(one('.toasts')).includes('浏览数据已清除'), 10_000)

  // ---- 信任所有网站和黑名单 ----
  const bridge = (
    window as unknown as {
      litchBrowser: { policy(): Promise<{ trustAll: boolean; blocked: string[] } | null> }
    }
  ).litchBrowser
  const trustBlock = await until('信任所有网站那一块取到', () => {
    const block = one('.set-content [data-trust-all]')
    return block && block.dataset.trustAll !== 'loading' ? block : null
  })
  const trustBefore = trustBlock.dataset.trustAll ?? ''
  const blocklistWhenOff = Boolean(one('[data-field="blocked-site"]', trustBlock))
  one<HTMLButtonElement>('[data-act="trust-all-sites"]', trustBlock)?.click()
  await seen(() => one('.set-content [data-trust-all="on"]'), 3000)
  const trustAfter = one('.set-content [data-trust-all]')?.dataset.trustAll ?? ''
  const field = await until('黑名单的输入框', () =>
    one<HTMLInputElement>('.set-content [data-field="blocked-site"]'),
  )
  const type = (value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }
  type('two words')
  await seen(() => !one<HTMLButtonElement>('.set-content [data-act="block-site"]')?.disabled, 2000)
  one<HTMLButtonElement>('.set-content [data-act="block-site"]')?.click()
  const badRefused =
    (await seen(() => field.getAttribute('aria-invalid') === 'true', 3000)) &&
    !one('.set-content [data-blocked-site]')
  type('https://WWW.Bank.example/login')
  await seen(() => !one<HTMLButtonElement>('.set-content [data-act="block-site"]')?.disabled, 2000)
  one<HTMLButtonElement>('.set-content [data-act="block-site"]')?.click()
  await seen(() => one('.set-content [data-blocked-site]'), 3000)
  const blockedRow = one('.set-content [data-blocked-site]')?.dataset.blockedSite ?? ''
  const stored = await bridge.policy()
  one<HTMLButtonElement>('.set-content [data-act="unblock-site"]')?.click()
  const removedEmpty = await seen(
    () => one('.set-content [data-blocked="0"]') && !one('.set-content [data-blocked-site]'),
    3000,
  )
  one<HTMLButtonElement>('.set-content [data-act="trust-all-sites"]')?.click()
  const offHidden = await seen(
    () =>
      one('.set-content [data-trust-all="off"]') &&
      !one('.set-content [data-field="blocked-site"]'),
    3000,
  )
  const storedOff = (await bridge.policy())?.trustAll === false

  // ---- Computer Use ----
  let computer: ToolsSeen['computer'] = null
  if (computerBridge) {
    await kit.openSettings('computer')
    const block = await until('权限问到', () => {
      const found = one('.set-content [data-perms]')
      return found && found.dataset.perms !== 'loading' && found.dataset.checking === 'false'
        ? found
        : null
    })
    const rows: Record<string, string> = {}
    for (const row of all('.perm-row', block)) rows[row.dataset.pane ?? ''] = row.dataset.perm ?? ''
    const openButtons = all('[data-act="open-pane"]', block).length
    const restart = one<HTMLButtonElement>('[data-act="restart-helper"]', block)
    // 假权限：点了只当作打开了，不会去开系统设置
    one<HTMLButtonElement>('[data-act="open-pane"]', block)?.click()
    restart?.click()
    const restartedOk = Boolean(
      restart &&
        (await seen(
          () =>
            one('.set-content [data-perms]')?.dataset.perms === 'ready' &&
            one('.set-content [data-perms]')?.dataset.checking === 'false',
          5000,
        )),
    )
    const appsBlock = await until('始终允许的应用取到', () => {
      const found = one('.set-content [data-apps]')
      return found && found.dataset.apps !== 'loading' ? found : null
    })
    one<HTMLButtonElement>('.set-content [data-act="open-devices"]')?.click()
    const toDevices = await seen(() => !one('.set-page') && one('.devp'), 3000)
    computer = {
      perms: block.dataset.perms ?? '',
      rows,
      openButtons,
      restartShown: Boolean(restart),
      restartedOk,
      apps: appsBlock.dataset.apps ?? '',
      toDevices,
    }
  }

  // ---- 设备详情：Computer Use 开关下面那一句 ----
  if (!one('.devp')) {
    one<HTMLButtonElement>('.sb-settings')?.click()
    ;(
      await until('设置页上进设备页的入口', () =>
        one<HTMLButtonElement>('.set-go[data-page="devices"]'),
      )
    ).click()
    await until('设备页', () => one('.devp'))
  }
  const openDevice = async (id: string) => {
    const item = await until(`设备页里的“${id}”`, () => one(`.devp-item[data-device="${id}"]`))
    one<HTMLButtonElement>('.devp-row', item)?.click()
    return until(`“${id}”的详情里的两个开关`, () =>
      one('[data-sec="tools"] [data-tool="computer"]'),
    )
  }
  const localRow = await openDevice('local')
  // 设置页那一组刚问过（假权限是两项都没给），这里不拉起助手，照上一次的说
  const hint = computerBridge
    ? await until('开关下面那一句', () => one<HTMLElement>('.tool-perm', localRow))
    : null
  const localHint = hint?.dataset.perm ?? 'none'
  let linkLands = ''
  if (hint) {
    one<HTMLButtonElement>('[data-act="computer-settings"]', hint)?.click()
    linkLands = (await seen(() => kit.settingsAt() === 'computer', 3000))
      ? 'computer'
      : (kit.settingsAt() ?? '没开')
    one<HTMLButtonElement>('.set-head .ibtn')?.click()
    await seen(() => !one('.set-page'), 3000)
    one<HTMLButtonElement>('.sb-settings')?.click()
    ;(
      await until('设置页上进设备页的入口', () =>
        one<HTMLButtonElement>('.set-go[data-page="devices"]'),
      )
    ).click()
    await until('设备页', () => one('.devp'))
  } else {
    // 详情里按 Esc 回到列表
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await until('设备列表', () => one('.devp-list'))
  }
  const remoteRow = await openDevice('build')
  const remoteSaysThisMac = text(remoteRow).includes('你面前的这台')
  // 收尾：关掉设备页
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await seen(() => !one('.devp[data-detail]'), 2000)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await seen(() => !one('.devp'), 2000)

  return {
    computerBridge,
    browser: {
      sites,
      confirmShown,
      cancelKeptQuiet,
      clearedToast,
      trustBefore,
      trustAfter,
      blocklistWhenOff,
      blockedRow,
      badRefused,
      stored,
      removedEmpty,
      offHidden,
      storedOff,
    },
    computer,
    devices: { localHint, linkLands, remoteSaysThisMac },
  }
}

/** 这一段的判定 */
export function judgeTools(seen: ToolsSeen, platform: string): string[] {
  const failed: string[] = []
  const must = (ok: unknown, what: string) => {
    if (!ok) failed.push(what)
  }
  const mac = platform === 'darwin'
  // Windows 上也有这一组，但没有系统权限那一块，下面权限那几条只在 macOS 上量
  const has = mac || platform === 'win32'
  must(seen.computerBridge === has, `Computer Use 的接口${has ? '没有' : '不该有'}`)
  must(seen.browser.sites === 'empty', `一直允许的网站不是空的样子：${seen.browser.sites}`)
  must(seen.browser.confirmShown, '点“清除浏览数据”没有先出确认框')
  must(seen.browser.cancelKeptQuiet, '确认框点了取消却清了，或者框没关')
  must(seen.browser.clearedToast, '确认清除之后没有出“浏览数据已清除”')
  const browser = seen.browser
  must(browser.trustBefore === 'off', `信任所有网站一开始不是关的：${browser.trustBefore}`)
  must(!browser.blocklistWhenOff, '信任所有网站关着时就出了黑名单')
  must(browser.trustAfter === 'on', `点了开关没有开：${browser.trustAfter}`)
  must(browser.badRefused, '认不出的网站没有提示，或者加进去了')
  must(browser.blockedRow === 'www.bank.example', `黑名单加进去的那一行不对：${browser.blockedRow}`)
  must(
    browser.stored?.trustAll === true &&
      JSON.stringify(browser.stored.blocked) === '["www.bank.example"]',
    `外壳那边记下来的不对：${JSON.stringify(browser.stored)}`,
  )
  must(browser.removedEmpty, '删掉黑名单那一项之后列表没空')
  must(browser.offHidden, '关掉信任所有网站之后黑名单没收起')
  must(browser.storedOff, '关掉之后外壳那边还开着')
  if (mac) {
    const computer = seen.computer
    must(computer, '设置页里没有 Computer Use 那一组')
    if (computer) {
      must(computer.perms === 'ready', `权限那一块不是问到了的样子：${computer.perms}`)
      must(
        computer.rows.accessibility === 'missing' && computer.rows.screenRecording === 'missing',
        `两项权限该都显示没给：${JSON.stringify(computer.rows)}`,
      )
      must(computer.openButtons === 2, `“打开系统设置”有 ${computer.openButtons} 个（应该两个）`)
      must(computer.restartShown, '屏幕录制没给时没有“重启助手”')
      must(computer.restartedOk, '点了“重启助手”之后权限那一块没有回到问到了的样子')
      must(computer.apps === 'empty', `始终允许的应用不是空的样子：${computer.apps}`)
      must(computer.toDevices, 'Computer Use 那一组的按钮没有通到设备页')
    }
    must(
      seen.devices.localHint === 'missing',
      `本机 Computer Use 开关下面该说没给全：${seen.devices.localHint}`,
    )
    must(seen.devices.linkLands === 'computer', `“去设置里看看”到了：${seen.devices.linkLands}`)
  } else if (has) {
    must(seen.computer, '设置页里没有 Computer Use 那一组')
    must(seen.devices.localHint === 'none', 'Windows 上不该在开关下面说系统权限')
  } else {
    must(seen.computer === null, '不是 macOS 却有 Computer Use 那一组')
    must(seen.devices.localHint === 'none', '不是 macOS 却在开关下面说了系统权限')
  }
  must(seen.devices.remoteSaysThisMac, '远程设备的 Computer Use 说明里没讲操作的是面前这台电脑')
  return failed
}
