// litch config 里只有主进程做得了的那几项（14 号设计 3.3）：内置浏览器“一直允许”的网站、信任所有网站和黑名单、浏览数据、
// Computer Use 的状态。核心的执行器经 CLIENT_TOOL 的 config 消息交过来，这里做完回 configResult。
// 和设置页上点按钮走的是同一份设置（browser/install.mts、computer-use/settings.mts），界面那边下次打开就是新的。
import type {
  ConfigComputerView,
  ConfigMainRequest,
  ConfigMainResult,
  ConfigSiteView,
} from '@litch/core'
import type { InstalledBrowser } from './browser/install.mjs'
import type { BrowserTargets } from './chrome-browser/browser-targets.mjs'
import type { ComputerUseSettings } from './computer-use/settings.mjs'

export interface ConfigMainDeps {
  chrome?(): BrowserTargets | null
  /** 内置浏览器。应用起来之前是 null */
  browser(): InstalledBrowser | null
  /** Computer Use 的设置。这台桌面没有 Computer Use（Linux）是 null */
  computer: ComputerUseSettings | null
}

const fail = (reason: string): ConfigMainResult => ({ ok: false, reason })

export function createConfigMain(deps: ConfigMainDeps) {
  return async (request: ConfigMainRequest): Promise<ConfigMainResult> => {
    try {
      switch (request.kind) {
        case 'chrome.status':
        case 'chrome.prepare':
        case 'chrome.extensions':
        case 'chrome.directory':
        case 'chrome.enable':
        case 'chrome.device':
        case 'chrome.stop': {
          const chrome = deps.chrome?.()
          if (!chrome) return fail('Chrome control is not ready.')
          return { ok: true, data: await chrome.settings(request) }
        }
        case 'browser.sites':
        case 'browser.allow':
        case 'browser.forget':
        case 'browser.clearData':
        case 'browser.policy':
        case 'browser.trust':
        case 'browser.block':
        case 'browser.unblock': {
          const browser = deps.browser()
          if (!browser) return fail('The built-in browser is not ready yet.')
          if (request.kind === 'browser.sites') {
            const sites: ConfigSiteView[] = browser.settings
              .listSites()
              .map((site) => ({ origin: site.origin, at: site.at }))
            return { ok: true, data: sites }
          }
          if (request.kind === 'browser.allow') {
            browser.sites.allowAlways(request.origin)
            return { ok: true, data: null }
          }
          if (request.kind === 'browser.forget') {
            return { ok: true, data: browser.settings.forgetSite(request.origin ?? undefined) }
          }
          if (request.kind === 'browser.policy')
            return { ok: true, data: browser.settings.policy() }
          if (request.kind === 'browser.trust') {
            return { ok: true, data: browser.settings.setTrustAll(request.on) }
          }
          if (request.kind === 'browser.block') {
            const policy = browser.settings.block(request.site)
            return policy
              ? { ok: true, data: policy }
              : fail(`Cannot read the site ${request.site}.`)
          }
          if (request.kind === 'browser.unblock') {
            browser.settings.unblock(request.host ?? undefined)
            return { ok: true, data: browser.settings.policy() }
          }
          await browser.settings.clearData()
          return { ok: true, data: null }
        }
        case 'computer.status': {
          if (!deps.computer) return { ok: true, data: null }
          // 和设置页那一节一样：没在跑就拉起助手问一次（macOS 的两项权限要问它才知道）
          const state = await deps.computer.status(true)
          const view: ConfigComputerView = {
            platform: state.platform,
            helper: state.helper,
            permissions: state.permissions,
            ...(state.reason ? { reason: state.reason } : {}),
          }
          return { ok: true, data: view }
        }
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
  }
}
