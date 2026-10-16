// 远端 localhost 的网址改写（决 191）：会话在 ssh 设备上时，localhost、127.0.0.1、[::1]、0.0.0.0、*.localhost
// 说的是那台远程机器自己。浏览器在桌面上，所以经 forward.mts 起一条 ssh 端口转发，把网址改到桌面的本机端口上。
// 本机设备的会话一律不动。纯函数加一个转发器，不碰 Electron。
//
// 改写的规矩：
// - 远端连哪：localhost、*.localhost、127.0.0.1、::1、0.0.0.0 都连远端的 localhost（由对面的 sshd 解析，
//   服务只听 IPv4 或只听 IPv6 都连得上）；别的 127.x.y.z 原样。同一个远端端口不管写成哪种只起一条转发。
// - 改成什么：localhost 和 *.localhost 保留主机名（网页看到的 Host 头、子域名路由都不变），
//   127.0.0.1、[::1]、0.0.0.0 一律改成 127.0.0.1（我们只在 IPv4 的回环上监听）；只换端口，路径、查询、片段不动。
// - 已经是这台设备某个转发的本机端口（模型或用户把桌面上的地址抄了回来、标签刷新）：不再当成远端端口转一次，
//   只在转发没在跑时把它重起。
import type { Forwarder } from './forward.mjs'

/** 远端要转发的地址和端口；不是远端本机地址是 null */
export interface RemoteLocal {
  remoteHost: string
  remotePort: number
}

const bare = (hostname: string) =>
  hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')

/** 这个网址是不是“这台机器自己”（远程会话里就是远程机器自己）。只认 http、https */
export function remoteLocalOf(url: URL): RemoteLocal | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const name = bare(url.hostname)
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  if (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    name === '127.0.0.1' ||
    name === '::1' ||
    name === '0:0:0:0:0:0:0:1' ||
    name === '0.0.0.0'
  ) {
    return { remoteHost: 'localhost', remotePort: port }
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return { remoteHost: name, remotePort: port }
  return null
}

/** 桌面上转发出来的地址：主机名按上面的规矩，端口换成本机端口 */
export function rewriteTo(url: URL, localPort: number): string {
  const next = new URL(url.toString())
  const name = bare(url.hostname)
  if (!(name === 'localhost' || name.endsWith('.localhost'))) next.hostname = '127.0.0.1'
  next.port = String(localPort)
  return next.toString()
}

/** 可能是桌面上某个转发的地址：主机是 localhost、*.localhost、127.0.0.1，带端口 */
function forwardedPortOf(url: URL): number | null {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const name = bare(url.hostname)
  if (!(name === 'localhost' || name.endsWith('.localhost') || name === '127.0.0.1')) return null
  const port = Number(url.port)
  return Number.isInteger(port) && port > 0 ? port : null
}

const parse = (text: string): URL | null => {
  try {
    return new URL(text)
  } catch {
    return null
  }
}

/** 给人和模型看的远端地址，比如 localhost:3000 */
const remoteLabel = (hit: RemoteLocal) =>
  `${hit.remoteHost.includes(':') ? `[${hit.remoteHost}]` : hit.remoteHost}:${hit.remotePort}`

export interface RemoteLocalResolver {
  /** 要不要改写（同步判断，网页自己跳转时用）：不用改是 false */
  needs(url: string, deviceId: string): boolean
  /** 改写：需要就起转发、等它就绪，回桌面上的地址；不需要原样回。起不来抛 ForwardError */
  resolve(url: string, deviceId: string): Promise<string>
  /** 这个地址是转发出来的话，给模型的一句说明；不是是 null */
  describe(url: string, deviceId: string): string | null
}

/**
 * isSsh：这台设备是不是 ssh 设备（本机和不认识的设备一律不改写）
 */
export function remoteLocalResolver(
  forwarder: Forwarder,
  isSsh: (deviceId: string) => boolean,
): RemoteLocalResolver {
  const needs = (url: string, deviceId: string): boolean => {
    if (!isSsh(deviceId)) return false
    const parsed = parse(url)
    if (!parsed || !remoteLocalOf(parsed)) return false
    const port = forwardedPortOf(parsed)
    const hit = port === null ? null : forwarder.local(deviceId, port)
    return !hit?.running
  }

  return {
    needs,
    async resolve(url, deviceId) {
      if (!needs(url, deviceId)) return url
      const parsed = parse(url) as URL
      const port = forwardedPortOf(parsed)
      const hit = port === null ? null : forwarder.local(deviceId, port)
      // 已经是桌面上的转发地址，只是 ssh 没在跑：按原来的远端端口重起（多半还是这个本机端口）
      const remote = hit ?? (remoteLocalOf(parsed) as RemoteLocal)
      const localPort = await forwarder.open(deviceId, remote.remoteHost, remote.remotePort)
      if (hit && localPort === port) return url
      return rewriteTo(parsed, localPort)
    },
    describe(url, deviceId) {
      if (!isSsh(deviceId)) return null
      const parsed = parse(url)
      const port = parsed ? forwardedPortOf(parsed) : null
      const hit = port === null ? null : forwarder.local(deviceId, port)
      if (!parsed || !hit) return null
      const remote = remoteLabel(hit)
      const lines = [
        `Note: ${parsed.host} in this tab is the remote device's ${remote}, forwarded over ssh to the user's desktop (the browser runs on the desktop). Keep using http://${remote}/... in your calls; Litch forwards it again.`,
      ]
      if (hit.problem) {
        lines.push(
          `ssh reported a problem reaching ${remote} on the remote device: ${hit.problem}. Check that a server is listening there.`,
        )
      }
      return lines.join('\n')
    },
  }
}
