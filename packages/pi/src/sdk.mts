import { pathToFileURL } from 'node:url'
import type * as PiAi from '@earendil-works/pi-ai'
import type * as PiSdk from '@earendil-works/pi-coding-agent'
import { hostPi } from './versions.mjs'

// Pi 本体不随适配器分发：值在运行时从用户安装的 Pi 加载，类型只在构建期来自开发依赖。
const host = hostPi()
// 用户的 Pi 可能比构建期类型对应的版本新：加载失败或缺少接口时立刻给出可操作的错误。
function incompatible(reason: string): Error {
  return new Error(
    `用户安装的 Pi ${host.version} 与适配器不兼容（${reason}）；请升级适配器，或用 PI_CLI 指定受支持的 Pi 版本`,
  )
}
const load = (url: URL): Promise<any> =>
  import(url.href).catch((error) => {
    throw incompatible(error instanceof Error ? error.message : String(error))
  })
const sdkUrl = pathToFileURL(host.sdkEntry)
const sdk: typeof PiSdk = await load(sdkUrl)
const ai: typeof PiAi = await load(pathToFileURL(host.aiEntry))
// 直接使用 CLI 的同一份内置扩展清单，包括可替换规则与 llama.cpp。
const extensions = await load(new URL('./extensions/index.js', sdkUrl))

export const {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  loadSkills,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} = sdk
export const { clampThinkingLevel, getSupportedThinkingLevels } = ai
export const builtInExtensions = extensions.builtInExtensions
const missing = Object.entries({
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  getAgentDir,
  loadSkills,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  clampThinkingLevel,
  getSupportedThinkingLevels,
  builtInExtensions,
})
  .filter(([, value]) => value === undefined)
  .map(([name]) => name)
if (missing.length) throw incompatible(`缺少 ${missing.join('、')}`)
export type DefaultResourceLoader = PiSdk.DefaultResourceLoader
export type SessionManager = PiSdk.SessionManager
export type SettingsManager = PiSdk.SettingsManager
