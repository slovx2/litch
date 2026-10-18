// 内置浏览器和远端 localhost 转发接在一起：给执行器的改写钩子和说明、用户地址栏用的改写、
// 网页自己跳转时的改写、标签还在不在用。转发本身在 ssh/forward.mts，网址怎么改在 ssh/forward-url.mts。
// install.mts 和远程端到端的自检（probe-tools-remote.mts）用的是同一份。不碰 Electron 的运行时。
import type { RemoteTarget } from '@litch/core'
import type { ClientToolDevice } from '../client-tools/types.mjs'
import { createForwarder, type Forwarder } from '../ssh/forward.mjs'
import { type RemoteLocalResolver, remoteLocalResolver } from '../ssh/forward-url.mjs'
import type { BrowserPage, TabInfo } from './model.mjs'
import { parseUrl } from './url.mjs'

export interface BrowserForwarding {
  forwarder: Forwarder
  resolver: RemoteLocalResolver
  /** 给执行器的 resolveUrl：代理的 navigate、新标签 */
  resolveUrl(url: string, device: ClientToolDevice): Promise<string>
  /** 给执行器的 describeUrl：转发出来的地址给模型一句说明 */
  describeUrl(url: string, device: ClientToolDevice): string | null
  /** 网页自己跳转时的改写（宿主的 setNavigationRewrite） */
  rewrite(page: BrowserPage, url: string): Promise<string> | null
  /** 用户在地址栏里打的：要改写就改写（等转发就绪），改写失败给一页说明 */
  forUser(deviceId: string, url: string): Promise<string>
  /** 用户打的这个地址要不要先改写（不用的话照旧同步打开） */
  needs(deviceId: string, url: string): boolean
  close(): void
}

/**
 * targetOf：设备配置里这台设备的 ssh 目标（本机、不认识的设备是 null）。
 * 执行器的调用里另带着设备的 ssh 目标（别名或 user@host）：设备配置里查不到时用它，并记下来给这台设备的用户标签用。
 * tabs：现在所有标签的样子，用来判断某个转发还有没有标签在用
 */
export function createBrowserForwarding(options: {
  targetOf(deviceId: string): RemoteTarget | null
  tabs(): TabInfo[]
  portsFile?: string
  ssh?: string
  idleMs?: number
  log?(line: string): void
}): BrowserForwarding {
  /** 从调用里认识的设备：设备配置里查不到时的后备 */
  const seen = new Map<string, RemoteTarget>()
  const targetOf = (deviceId: string): RemoteTarget | null =>
    deviceId === 'local' ? null : (options.targetOf(deviceId) ?? seen.get(deviceId) ?? null)
  const learn = (device: ClientToolDevice) => {
    if (device.kind === 'ssh' && device.target && !device.target.startsWith('-')) {
      seen.set(device.id, { kind: 'alias', alias: device.target })
    }
  }

  const portOf = (url: string): number | null => {
    const parsed = parseUrl(url)
    if (!parsed?.port) return null
    return Number(parsed.port)
  }
  const forwarder = createForwarder({
    targetOf,
    inUse: (deviceId, localPort) =>
      options
        .tabs()
        .some((tab) => tab.owner.deviceId === deviceId && portOf(tab.url) === localPort),
    ...(options.portsFile ? { portsFile: options.portsFile } : {}),
    ...(options.ssh ? { ssh: options.ssh } : {}),
    ...(options.idleMs ? { idleMs: options.idleMs } : {}),
    ...(options.log ? { log: options.log } : {}),
  })
  const resolver = remoteLocalResolver(forwarder, (deviceId) => targetOf(deviceId) !== null)

  return {
    forwarder,
    resolver,
    async resolveUrl(url, device) {
      learn(device)
      if (device.kind !== 'ssh') return url
      try {
        return await resolver.resolve(url, device.id)
      } catch (error) {
        throw new Error(
          `could not forward ${url} from the remote device "${device.name}" over ssh: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
    describeUrl(url, device) {
      if (device.kind !== 'ssh') return null
      learn(device)
      return resolver.describe(url, device.id)
    },
    rewrite(page, url) {
      const deviceId = page.info().owner.deviceId
      return resolver.needs(url, deviceId) ? resolver.resolve(url, deviceId) : null
    },
    needs: (deviceId, url) => resolver.needs(url, deviceId),
    async forUser(deviceId, url) {
      try {
        return await resolver.resolve(url, deviceId)
      } catch (error) {
        return failurePage(url, error instanceof Error ? error.message : String(error))
      }
    },
    close: () => forwarder.close(),
  }
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  )

/**
 * 远端地址转发不成时给用户标签的一页说明（data: 网址，不出网）。主进程不知道界面现在的语言，中英文都写
 */
export function failurePage(url: string, why: string): string {
  const html = `<!doctype html><meta charset="utf-8"><title>Litch</title>
<style>body{font:14px -apple-system,system-ui,sans-serif;margin:3em;color:#333}code{word-break:break-all}</style>
<h3>无法打开远程设备上的地址 / Could not open the remote address</h3>
<p><code>${escapeHtml(url)}</code></p>
<p>经 ssh 转发到这台电脑时出错 / Forwarding it over ssh failed:</p>
<p><code>${escapeHtml(why)}</code></p>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
