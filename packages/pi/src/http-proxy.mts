import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from './sdk.mjs'

// settings.json 的 httpProxy：Pi 命令行启动时把它补成 HTTP_PROXY、HTTPS_PROXY（环境里已有的不动，
// main.js 的 applyHttpProxySettings），SDK 建会话时不做这一步。运行时启动时照命令行补上，
// 设置页才说得准“改了重启生效”。

const NAMES = ['HTTPS_PROXY', 'HTTP_PROXY']

// 这个模块加载时（运行时起来、还没补之前）环境里已有的代理变量：有它时设置里的 httpProxy 被盖住
const original = (() => {
  for (const name of NAMES) {
    const value = process.env[name]?.trim()
    if (value) return { name, value }
  }
  return null
})()

export function environmentProxy(): { name: string; value: string } | null {
  return original
}

export function applyHttpProxy(): void {
  let proxy: unknown
  try {
    proxy = JSON.parse(readFileSync(join(getAgentDir(), 'settings.json'), 'utf8')).httpProxy
  } catch {
    return
  }
  if (typeof proxy !== 'string' || !proxy.trim()) return
  process.env.HTTP_PROXY ??= proxy.trim()
  process.env.HTTPS_PROXY ??= proxy.trim()
}
