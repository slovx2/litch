// litch config 里管这台桌面端自己的几组：status、open、look、browser、computer、notify。
// 外观、语言、两个本地偏好、打开某一页在界面那边（经 bridge）；浏览器网站、Computer Use 在主进程那边（经 main）。
import type { DeviceView } from '../model.mjs'
import type {
  ConfigAppView,
  ConfigComputerView,
  ConfigOpenPlace,
  ConfigPrefs,
  ConfigSitePolicyView,
  ConfigSiteView,
} from '../model-config.mjs'
import { parseSwitch } from './argv.mjs'
import { ConfigFailure, type OpContext, type OpSpec } from './context.mjs'
import { deviceData, harnessLine } from './ops-devices.mjs'
import { phoneCount } from './ops-places.mjs'

const SKINS = ['retro', 'human', 'standard']
const MODES = ['light', 'dark', 'system']
const DENSITIES = ['compact', 'standard', 'roomy']
/** 界面缩放的几档（和界面的 ZOOMS 一致） */
const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.5]
/** 设置页的几组，和界面 SettingsPage.tsx 的 SETTINGS_SECTIONS 同一个顺序 */
export const SETTINGS_SECTIONS = [
  'look',
  'lang',
  'devices',
  'browser',
  'computer',
  'notify',
  'assist',
  'keys',
  'about',
]

const prefsLine = (prefs: ConfigPrefs) =>
  `language ${prefs.lang} · skin ${prefs.skin} · mode ${prefs.theme} · density ${prefs.density} · zoom ${Math.round(prefs.zoom * 100)}% · links ${prefs.linksInApp ? 'in-app' : 'system'} · task-success notices ${prefs.notifySuccess ? 'on' : 'off'}`

const setPrefs = async (ctx: OpContext, patch: Partial<ConfigPrefs>) => {
  const prefs = (await ctx.ui({ kind: 'prefs.set', patch })) as ConfigPrefs
  return { text: prefsLine(prefs), data: prefs }
}

const bad = (ctx: OpContext, zh: string, en: string) =>
  new ConfigFailure('invalid', ctx.say(zh, en))

/** 黑名单那一行：开关在前，后面是主机名 */
const policyText = (ctx: OpContext, policy: ConfigSitePolicyView) =>
  [
    ctx.say(
      `信任所有网站：${policy.trustAll ? '开' : '关'}`,
      `Trust all sites: ${policy.trustAll ? 'on' : 'off'}`,
    ),
    policy.blocked.length > 0
      ? ctx.say(`黑名单：${policy.blocked.join(', ')}`, `Blocklist: ${policy.blocked.join(', ')}`)
      : ctx.say('黑名单是空的', 'Blocklist is empty'),
  ].join('\n')

/** 网站写法认成来源：https://example.com/x → https://example.com；不写协议的当 https */
export function originOf(raw: string): string | null {
  const text = raw.trim()
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`
  const match = /^(https?):\/\/(?:[^@/?#]*@)?([^/?#:]+|\[[^\]]+\])(?::(\d+))?(?:[/?#]|$)/i.exec(
    full,
  )
  if (!match?.[1] || !match[2]) return null
  const scheme = match[1].toLowerCase()
  const host = match[2].toLowerCase()
  if (!/^[a-z0-9.\-_]+$|^\[[0-9a-f:.]+\]$/i.test(host)) return null
  const port =
    match[3] &&
    !(scheme === 'http' && match[3] === '80') &&
    !(scheme === 'https' && match[3] === '443')
      ? `:${match[3]}`
      : ''
  return `${scheme}://${host}${port}`
}

const deviceStatus = async (ctx: OpContext, device: DeviceView) => {
  const phones =
    device.pairing && device.connection === 'online' ? await phoneCount(ctx, device.id) : null
  const tools = [
    device.tools.browser === null ? null : `browser ${device.tools.browser ? 'on' : 'off'}`,
    device.tools.computer === null ? null : `computer ${device.tools.computer ? 'on' : 'off'}`,
    device.machine
      ? `machine ${device.machine.enabled ? `on (${device.machine.approval}, ${device.machine.access.mode})` : 'off'}`
      : null,
  ].filter(Boolean)
  const line = [
    `${device.id} "${ctx.nameOf(device)}" ${device.host} · ${device.connection} (${device.mode})`,
    `  harnesses: ${device.harnesses.map(harnessLine).join(', ') || '-'}`,
    `  tools: ${tools.join(', ') || '-'}${phones === null ? '' : ` · phones: ${phones}`}`,
  ].join('\n')
  return { line, data: { ...deviceData(device, ctx.nameOf(device)), phones } }
}

export const APP_OPS: Record<string, OpSpec> = {
  status: {
    args: [0, 0],
    usage: 'status',
    summary: {
      zh: '总览：设备、harness、工具开关、手机、版本、语言与外观',
      en: 'Overview: devices, harnesses, tool switches, phones, version, language and look',
    },
    async run(ctx) {
      const devices = await ctx.devices()
      const rows = await Promise.all(devices.map((device) => deviceStatus(ctx, device)))
      let prefs: ConfigPrefs | null = null
      try {
        prefs = (await ctx.ui({ kind: 'prefs.get' })) as ConfigPrefs
      } catch {
        // 没有开着的窗口：外观和语言这次不报
      }
      return {
        text: [
          `Litch ${ctx.host.version}${prefs ? ` · ${prefsLine(prefs)}` : ''}`,
          ...rows.map((row) => row.line),
        ].join('\n'),
        data: { version: ctx.host.version, prefs, devices: rows.map((row) => row.data) },
      }
    },
  },
  open: {
    args: [1, 2],
    usage: `open settings[/${SETTINGS_SECTIONS.join('|')}] | open device <device> | open tasks | open new`,
    summary: { zh: '在桌面端打开某一页', en: 'Open a page in the desktop app' },
    async run(ctx) {
      const [where = '', arg] = ctx.cmd.positionals
      let place: ConfigOpenPlace
      if (where === 'settings' || where.startsWith('settings/')) {
        const section = where.includes('/') ? where.slice(where.indexOf('/') + 1) : null
        if (section !== null && !SETTINGS_SECTIONS.includes(section)) {
          throw bad(ctx, `设置里没有这一组：${section}`, `No such settings section: ${section}`)
        }
        place = { where: 'settings', section }
      } else if (where === 'device') {
        place = { where: 'device', deviceId: (await ctx.device(arg)).id }
      } else if (where === 'tasks') place = { where: 'tasks' }
      else if (where === 'new') place = { where: 'new' }
      else throw bad(ctx, `不知道打开哪：${where}`, `Unknown page: ${where}`)
      await ctx.ui({ kind: 'open', place })
      return { text: ctx.say('打开了。', 'Opened.') }
    },
  },
  'look set': {
    args: [0, 0],
    options: ['skin', 'mode', 'density', 'zoom'],
    usage: `look set [--skin ${SKINS.join('|')}] [--mode ${MODES.join('|')}] [--density ${DENSITIES.join('|')}] [--zoom ${ZOOMS.map((zoom) => `${Math.round(zoom * 100)}`).join('|')}]`,
    summary: {
      zh: '换外观（皮肤、明暗、密度、缩放）',
      en: 'Change the look (skin, light/dark, density, zoom)',
    },
    async run(ctx) {
      const get = (name: string) => ctx.cmd.options.get(name)
      const patch: Partial<ConfigPrefs> = {}
      const skin = get('skin')
      if (skin !== undefined) {
        if (!SKINS.includes(skin))
          throw bad(ctx, `皮肤只能是 ${SKINS.join('、')}`, `--skin must be ${SKINS.join(', ')}`)
        patch.skin = skin
      }
      const mode = get('mode')
      if (mode !== undefined) {
        if (!MODES.includes(mode))
          throw bad(ctx, `明暗只能是 ${MODES.join('、')}`, `--mode must be ${MODES.join(', ')}`)
        patch.theme = mode
      }
      const density = get('density')
      if (density !== undefined) {
        if (!DENSITIES.includes(density))
          throw bad(
            ctx,
            `密度只能是 ${DENSITIES.join('、')}`,
            `--density must be ${DENSITIES.join(', ')}`,
          )
        patch.density = density
      }
      const zoomRaw = get('zoom')
      if (zoomRaw !== undefined) {
        const number = Number(zoomRaw.replace(/%$/, ''))
        const zoom = number > 5 ? number / 100 : number
        if (!ZOOMS.includes(zoom)) {
          throw bad(
            ctx,
            `缩放只能是 ${ZOOMS.map((one) => `${one * 100}%`).join('、')}`,
            `--zoom must be one of ${ZOOMS.map((one) => `${one * 100}`).join(', ')}`,
          )
        }
        patch.zoom = zoom
      }
      if (Object.keys(patch).length === 0)
        throw bad(ctx, '至少给一项。', 'Pass at least one option.')
      return setPrefs(ctx, patch)
    },
  },
  'look language': {
    args: [1, 1],
    usage: 'look language zh-CN|en',
    summary: { zh: '换界面语言', en: 'Change the interface language' },
    async run(ctx) {
      const lang = ctx.cmd.positionals[0]
      if (lang !== 'zh-CN' && lang !== 'en') throw bad(ctx, '只能是 zh-CN 或 en', 'Use zh-CN or en')
      return setPrefs(ctx, { lang })
    },
  },
  'browser links': {
    args: [1, 1],
    usage: 'browser links in-app|system',
    summary: {
      zh: '对话里的链接在内置浏览器还是系统浏览器里开',
      en: 'Open links from conversations in the built-in or the system browser',
    },
    async run(ctx) {
      const value = ctx.cmd.positionals[0]
      if (value !== 'in-app' && value !== 'system')
        throw bad(ctx, '只能是 in-app 或 system', 'Use in-app or system')
      return setPrefs(ctx, { linksInApp: value === 'in-app' })
    },
  },
  'browser sites': {
    args: [0, 0],
    usage: 'browser sites',
    summary: { zh: '内置浏览器“一直允许”的网站', en: 'Sites the built-in browser always allows' },
    async run(ctx) {
      const sites = (await ctx.main({ kind: 'browser.sites' })) as ConfigSiteView[]
      return {
        text: sites.map((site) => site.origin).join('\n') || ctx.say('没有。', 'None.'),
        data: sites,
      }
    },
  },
  'browser allow': {
    args: [1, 1],
    usage: 'browser allow <site>',
    summary: {
      zh: '内置浏览器“一直允许”一个网站（要用户在桌面端点允许）',
      en: 'Always allow a site in the built-in browser (the user must allow it on the desktop)',
    },
    async run(ctx) {
      const origin = originOf(ctx.cmd.positionals[0] ?? '')
      if (!origin)
        throw bad(
          ctx,
          '网站要写成 https://example.com 这样',
          'Write the site like https://example.com',
        )
      await ctx.confirm([{ kind: 'site', origin }])
      await ctx.main({ kind: 'browser.allow', origin })
      return { text: ctx.say(`一直允许 ${origin}。`, `Always allowing ${origin}.`) }
    },
  },
  'browser forget': {
    args: [0, 1],
    flags: ['all'],
    usage: 'browser forget <site> | browser forget --all',
    summary: { zh: '去掉“一直允许”的网站', en: 'Forget always-allowed sites' },
    async run(ctx) {
      const all = ctx.cmd.flags.has('all')
      const raw = ctx.cmd.positionals[0]
      if (all === (raw !== undefined))
        throw bad(ctx, '给一个网站，或者 --all。', 'Pass a site or --all.')
      const origin = raw === undefined ? null : originOf(raw)
      if (raw !== undefined && !origin) throw bad(ctx, '网站认不出', 'Cannot read the site')
      const removed = (await ctx.main({ kind: 'browser.forget', origin })) as number
      return { text: ctx.say(`去掉了 ${removed} 个。`, `Forgot ${removed}.`), data: { removed } }
    },
  },
  'browser trust': {
    args: [1, 1],
    usage: 'browser trust on|off',
    summary: {
      zh: '内置浏览器信任所有网站、不再询问（黑名单里的除外；打开要用户在桌面端点允许）',
      en: 'Trust all sites in the built-in browser without asking, except the blocklist (turning it on needs the user to allow it on the desktop)',
    },
    async run(ctx) {
      const on = parseSwitch(ctx.cmd.positionals[0])
      if (on === null) throw bad(ctx, '只能是 on 或 off', 'Use on or off')
      if (on) await ctx.confirm([{ kind: 'trustAllSites' }])
      const policy = (await ctx.main({ kind: 'browser.trust', on })) as ConfigSitePolicyView
      return { text: policyText(ctx, policy), data: policy }
    },
  },
  'browser blocked': {
    args: [0, 0],
    usage: 'browser blocked',
    summary: {
      zh: '信任所有网站的开关和黑名单',
      en: 'Whether all sites are trusted, and the blocklist',
    },
    async run(ctx) {
      const policy = (await ctx.main({ kind: 'browser.policy' })) as ConfigSitePolicyView
      return { text: policyText(ctx, policy), data: policy }
    },
  },
  'browser block': {
    args: [1, 1],
    usage: 'browser block <site>',
    summary: {
      zh: '把一个网站加进黑名单（子域名一起算；只在信任所有网站时起作用）',
      en: 'Add a site to the blocklist (subdomains included; only matters while all sites are trusted)',
    },
    async run(ctx) {
      const site = ctx.cmd.positionals[0] ?? ''
      if (!originOf(site.replace(/^\s*\*\./, '')))
        throw bad(ctx, '网站要写成 example.com 这样', 'Write the site like example.com')
      const policy = (await ctx.main({ kind: 'browser.block', site })) as ConfigSitePolicyView
      return { text: policyText(ctx, policy), data: policy }
    },
  },
  'browser unblock': {
    args: [0, 1],
    flags: ['all'],
    usage: 'browser unblock <site> | browser unblock --all',
    summary: {
      zh: '从黑名单里去掉网站（要用户在桌面端点允许）',
      en: 'Remove sites from the blocklist (the user allows it on the desktop)',
    },
    async run(ctx) {
      const all = ctx.cmd.flags.has('all')
      const raw = ctx.cmd.positionals[0]
      if (all === (raw !== undefined))
        throw bad(ctx, '给一个网站，或者 --all。', 'Pass a site or --all.')
      const host =
        raw === undefined
          ? null
          : (originOf(raw.replace(/^\s*\*\./, ''))
              ?.replace(/^https?:\/\//, '')
              .replace(/:\d+$/, '') ?? null)
      if (raw !== undefined && !host) throw bad(ctx, '网站认不出', 'Cannot read the site')
      await ctx.confirm([{ kind: 'unblock', host }])
      const policy = (await ctx.main({ kind: 'browser.unblock', host })) as ConfigSitePolicyView
      return { text: policyText(ctx, policy), data: policy }
    },
  },
  'browser clear-data': {
    args: [0, 0],
    usage: 'browser clear-data',
    summary: {
      zh: '清除内置浏览器的浏览数据（撤不回，要用户在桌面端点允许）',
      en: 'Clear built-in browser data (irreversible; the user allows it on the desktop)',
    },
    async run(ctx) {
      await ctx.confirm([{ kind: 'erase', what: 'browserData', device: null, name: null }])
      await ctx.main({ kind: 'browser.clearData' })
      return { text: ctx.say('清掉了。', 'Cleared.') }
    },
  },
  'computer status': {
    args: [0, 0],
    usage: 'computer status',
    summary: {
      zh: 'Computer Use 的助手和系统权限（授权要用户自己在系统设置里点）',
      en: 'Computer Use helper and system permissions (the user grants them in system settings)',
    },
    async run(ctx) {
      const state = (await ctx.main({ kind: 'computer.status' })) as ConfigComputerView | null
      if (!state)
        return {
          text: ctx.say('这台桌面端没有 Computer Use。', 'This desktop has no Computer Use.'),
          data: null,
        }
      const permissions = state.permissions
        ? `accessibility ${state.permissions.accessibility ? 'granted' : 'missing'}, screen recording ${state.permissions.screenRecording ? 'granted' : 'missing'}`
        : 'permissions unknown'
      return {
        text: `${state.platform} · helper ${state.helper} · ${permissions}${state.reason ? ` · ${state.reason}` : ''}`,
        data: state,
      }
    },
  },
  'computer apps': {
    args: [0, 0],
    usage: 'computer apps',
    summary: { zh: 'Computer Use“始终允许”的应用', en: 'Apps Computer Use always allows' },
    async run(ctx) {
      const apps = (await ctx.main({ kind: 'computer.apps' })) as ConfigAppView[]
      return {
        text:
          apps.map((app) => `${app.bundleId} "${app.name}"`).join('\n') ||
          ctx.say('没有。', 'None.'),
        data: apps,
      }
    },
  },
  'computer forget': {
    args: [1, 1],
    usage: 'computer forget <bundle-id>',
    summary: { zh: '从“始终允许”里去掉一个应用', en: 'Remove an app from always-allowed' },
    async run(ctx) {
      const removed = (await ctx.main({
        kind: 'computer.forget',
        bundleId: ctx.cmd.positionals[0] ?? '',
      })) as boolean
      if (!removed) throw bad(ctx, '“始终允许”里没有它。', 'It is not in the always-allowed list.')
      return { text: ctx.say('去掉了。', 'Removed.') }
    },
  },
  'notify task-success': {
    args: [1, 1],
    usage: 'notify task-success on|off',
    summary: {
      zh: '定时任务成功跑完也发系统通知',
      en: 'Also notify when a scheduled task succeeds',
    },
    async run(ctx) {
      const on = parseSwitch(ctx.cmd.positionals[0])
      if (on === null) throw bad(ctx, '只能是 on 或 off', 'Use on or off')
      return setPrefs(ctx, { notifySuccess: on })
    },
  },
}
