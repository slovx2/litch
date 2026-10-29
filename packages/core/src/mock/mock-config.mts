// 模拟核心的 litch config：和真的核心用同一个执行器、同一条界面桥（config 主题），只是主进程那几项换成假的
// （内置浏览器一直允许的网站、Computer Use 的状态）。
// 对话里说“配置：<参数>”（英文 “config: <args>”）就当本机 harness 里的模型跑了一次 litch config，
// 放宽安全的那几项照样弹确认卡，界面那几项照样交给最近订阅的窗口去做。
import { ChannelError, type Clock, type Commands } from '../channel/protocol.mjs'
import type { CoreHost, HostSink } from '../channel/server.mjs'
import { splitWords } from '../config/argv.mjs'
import { createConfigBridge } from '../config/bridge.mjs'
import type { ConfigCaller } from '../config/context.mjs'
import { type ConfigExecutor, createConfigExecutor } from '../config/executor.mjs'
import type {
  ConfigComputerView,
  ConfigMainRequest,
  ConfigMainResult,
  ConfigSitePolicyView,
  ConfigSiteView,
} from '../model-config.mjs'
import type { SampleLang } from './sample-text.mjs'

export interface MockConfigHost {
  clock: Clock
  version: string
  lang: SampleLang
  /** 模拟核心自己（执行器经它的命令和主题做事）。建好核心之后才有，所以是个函数 */
  core(): CoreHost
}

export interface MockConfig {
  subscribe(sink: HostSink): () => void
  /** 是 config 的命令就处理；不是就返回 undefined，交给别处 */
  command(name: string, params: unknown): Promise<unknown> | undefined
  /** 对话里的“配置：…”：跑一次，回给模型看的那段字 */
  run(line: string, caller: Omit<ConfigCaller, 'hold'>): Promise<{ ok: boolean; text: string }>
}

/** 对话里这样开头的一句当成一次 litch config */
export const RUNS_CONFIG = /^\s*(?:配置[:：]|config:)\s*(.*)$/is

const NAMES: readonly string[] = ['config.reply', 'config.confirm', 'config.run']

export function createMockConfig(host: MockConfigHost): MockConfig {
  const bridge = createConfigBridge(host.clock)
  // 主进程那几项的假状态
  const sites: ConfigSiteView[] = [
    { origin: 'https://github.com', at: host.clock.now() - 86_400_000 },
  ]
  const policy: ConfigSitePolicyView = { trustAll: false, blocked: [] }
  const computer: ConfigComputerView = {
    platform: 'darwin',
    helper: 'ready',
    permissions: { accessibility: true, screenRecording: false },
  }

  const main = async (request: ConfigMainRequest): Promise<ConfigMainResult> => {
    switch (request.kind) {
      case 'browser.sites':
        return { ok: true, data: sites.map((site) => ({ ...site })) }
      case 'browser.allow':
        if (!sites.some((site) => site.origin === request.origin)) {
          sites.push({ origin: request.origin, at: host.clock.now() })
        }
        return { ok: true, data: null }
      case 'browser.forget': {
        const before = sites.length
        const kept = sites.filter(
          (site) => request.origin !== null && site.origin !== request.origin,
        )
        sites.splice(0, sites.length, ...kept)
        return { ok: true, data: before - sites.length }
      }
      case 'browser.clearData':
        return { ok: true, data: null }
      case 'browser.policy':
        return { ok: true, data: { ...policy, blocked: [...policy.blocked] } }
      case 'browser.trust':
        policy.trustAll = request.on
        return { ok: true, data: { ...policy, blocked: [...policy.blocked] } }
      case 'browser.block': {
        const host = request.site
          .trim()
          .replace(/^\*\./, '')
          .replace(/^https?:\/\//, '')
          .replace(/[/:?#].*$/, '')
          .toLowerCase()
        if (!host) return { ok: false, reason: `Cannot read the site ${request.site}.` }
        if (!policy.blocked.includes(host)) policy.blocked = [...policy.blocked, host].sort()
        return { ok: true, data: { ...policy, blocked: [...policy.blocked] } }
      }
      case 'browser.unblock':
        policy.blocked =
          request.host === null ? [] : policy.blocked.filter((one) => one !== request.host)
        return { ok: true, data: { ...policy, blocked: [...policy.blocked] } }
      case 'chrome.status':
      case 'chrome.prepare':
      case 'chrome.extensions':
      case 'chrome.directory':
      case 'chrome.enable':
      case 'chrome.device':
      case 'chrome.stop':
        return { ok: false, reason: 'Chrome requires the desktop shell.' }
      case 'computer.status':
        return { ok: true, data: computer }
    }
  }

  let executor: ConfigExecutor | null = null
  const executorOf = (): ConfigExecutor => {
    executor ??= createConfigExecutor({
      core: host.core(),
      clock: host.clock,
      version: host.version,
      lang: () => host.lang,
      bridge,
      main,
    })
    return executor
  }

  const textOf = (response: Awaited<ReturnType<ConfigExecutor['run']>>) => ({
    ok: response.success,
    text: response.contentItems
      .map((item) => (item.type === 'inputText' ? item.text : ''))
      .join('\n'),
  })

  return {
    subscribe: (sink) => bridge.subscribe(sink),

    command(name, params) {
      if (!NAMES.includes(name)) return undefined
      return Promise.resolve().then(async () => {
        if (name === 'config.reply') {
          const { id, ok, data, reason } = params as Commands['config.reply']['params']
          if (!bridge.reply(String(id), ok === true, data, reason ?? null)) {
            throw new ChannelError('notFound', '这件事已经不等了')
          }
          return {}
        }
        if (name === 'config.confirm') {
          const { id, allow } = params as Commands['config.confirm']['params']
          if (!bridge.answer(String(id), allow === true)) {
            throw new ChannelError('notFound', '这张卡片已经不在了')
          }
          return {}
        }
        const { argv, json, lang } = params as Commands['config.run']['params']
        return textOf(
          await executorOf().run(
            { argv, json: json === true, lang: lang ?? null },
            { threadId: null, harness: null, hold: () => () => {} },
          ),
        )
      })
    },

    async run(line, caller) {
      const argv = splitWords(line)
      return textOf(
        await executorOf().run(
          { argv, json: false, lang: null },
          { ...caller, hold: () => () => {} },
        ),
      )
    },
  }
}
