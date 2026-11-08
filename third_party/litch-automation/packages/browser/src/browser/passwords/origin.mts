// 密码按源存、按源填。这里是两条纯规则：存进来的源怎么规范化，哪种页面的源可以拿来填。
// 不引 electron，单元测试直接跑（test/passwords-store.test.mts）。

/** 本机回环：这几种主机上的 http 页面也填（开发时本机起的登录页） */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

const isLoopback = (hostname: string): boolean =>
  LOOPBACK.has(hostname) || hostname.endsWith('.localhost')

/**
 * 导入来的源（或登录页地址）规范化成 `scheme://host[:port]`。只认 http、https，别的（安卓应用、
 * 带用户名密码的、认不出的）回 null，由调用的人计入“无效跳过”
 */
export function normalizeOrigin(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== '' || parsed.hostname === '') return null
  return parsed.origin
}

/**
 * 一个框架的真实源（主进程从 senderFrame 取的，不是预加载报的）能不能拿来填：
 * https 都行，http 只许本机回环，其余（含不透明的 "null"、file:、data:）一律不填。能填回规范化的源
 */
export function fillableOrigin(frameOrigin: string): string | null {
  if (frameOrigin === '' || frameOrigin === 'null') return null
  const origin = normalizeOrigin(frameOrigin)
  if (!origin) return null
  const parsed = new URL(origin)
  if (parsed.protocol === 'https:') return origin
  return isLoopback(parsed.hostname) ? origin : null
}
