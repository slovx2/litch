// macOS 上哪些应用不许操作、哪些算高风险（按平台分派在 policy.mts）。按包标识认，认不出包标识的再看名字。
//
// 禁止（当场回 declined，不弹卡片）：Litch 自己和它的助手、钥匙串与密码类应用、系统认证弹窗、系统设置
// （模型能点系统设置就能给自己开权限、关掉安全设置）。
// 高风险（卡片上标出来）：浏览器（里面有用户的登录态、能看到提示词注入的网页）、终端和能直接跑脚本的应用。
// 助手那一侧还有一份底线名单（apps/computer-use/Sources/LitchComputerUseCore/Baseline.swift），那份里的每一项这里都要有。

import type { AppRisk } from './policy.mjs'

const FORBIDDEN_IDS = new Set([
  'io.github.slovx2.litch',
  'io.github.slovx2.litch.computer-use',
  'com.apple.keychainaccess',
  'com.apple.Passwords',
  'com.apple.SecurityAgent',
  'com.apple.LocalAuthentication.UIAgent',
  'com.apple.loginwindow',
  'com.apple.systempreferences',
  'com.apple.Settings',
  'com.apple.CoreServicesUIAgent',
  'com.apple.UserNotificationCenter',
])

/** 包标识以这些开头的一律禁止（密码管理器） */
const FORBIDDEN_PREFIXES = [
  'com.1password.',
  'com.agilebits.',
  'com.bitwarden.',
  'com.lastpass.',
  'com.dashlane.',
  'com.nordpass.',
  'me.proton.pass',
  'org.keepassxc.',
  'com.keepersecurity.',
  'in.sinew.enpass',
  'com.enpass.',
]

/** 名字里带这些的也当密码管理器 */
const FORBIDDEN_NAME_WORDS = ['password', '密码', 'keychain', '钥匙串', 'keepass', 'bitwarden']

const ELEVATED_IDS = new Set([
  // 浏览器
  'com.apple.Safari',
  'com.apple.SafariTechnologyPreview',
  'org.mozilla.firefox',
  'org.mozilla.firefoxdeveloperedition',
  'org.mozilla.nightly',
  'org.chromium.Chromium',
  'com.brave.Browser',
  'com.vivaldi.Vivaldi',
  'company.thebrowser.Browser',
  'company.thebrowser.dia',
  'ai.perplexity.comet',
  'com.openai.atlas',
  'app.zen-browser.zen',
  // 终端
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'dev.warp.Warp-Stable',
  'net.kovidgoyal.kitty',
  'com.github.wez.wezterm',
  'com.mitchellh.ghostty',
  'io.alacritty',
  'com.raphaelamorim.rio',
  'dev.commandline.waveterm',
  'co.zeit.hyper',
  // 能直接跑脚本的
  'com.apple.ScriptEditor2',
  'com.apple.Automator',
  'com.apple.shortcuts',
])

const ELEVATED_PREFIXES = [
  'com.google.Chrome',
  'com.microsoft.edgemac',
  'com.operasoftware.Opera',
  'com.brave.Browser',
]

export function classifyMacApp(app: { bundleId: string | null; name: string }): AppRisk {
  const id = app.bundleId ?? ''
  if (id && (FORBIDDEN_IDS.has(id) || FORBIDDEN_PREFIXES.some((prefix) => id.startsWith(prefix)))) {
    return 'forbidden'
  }
  const name = app.name.toLowerCase()
  if (FORBIDDEN_NAME_WORDS.some((word) => name.includes(word))) return 'forbidden'
  if (id && (ELEVATED_IDS.has(id) || ELEVATED_PREFIXES.some((prefix) => id.startsWith(prefix)))) {
    return 'elevated'
  }
  return 'normal'
}

/** 测试用：两边名单的对照 */
export const FORBIDDEN_FOR_TEST = { ids: FORBIDDEN_IDS, prefixes: FORBIDDEN_PREFIXES }
