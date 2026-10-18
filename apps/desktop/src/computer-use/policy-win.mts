// Windows 上哪些应用不许操作、哪些算高风险（按平台分派在 policy.mts）。名单是自己整理的。
//
// 认应用看三样：exe 的文件名、版本资源里的 OriginalFilename（改了文件名也认得出）、AUMID（打包应用）。都不分大小写。
// 认不出的再看显示名里有没有“密码”一类的字（和 macOS 一样，宁可错拦密码管理器）。
//
// 禁止（当场回 declined，不弹卡片）：Litch 自己和助手；密码管理器；Windows 安全中心、Defender 和常见杀毒软件的界面；
// 凭据与提权界面；系统设置、控制面板、注册表编辑器、组策略、服务、任务计划程序、mmc、任务管理器（能改系统设置就能
// 给自己开权限、关掉安全设置）；官方的 ChatGPT / Codex 桌面端。
// 高风险（卡片上标出来，远程会话不给“始终允许”这一条对所有应用都成立）：浏览器、终端与命令行、文件资源管理器
// （地址栏能直接跑命令）、能直接跑脚本的宿主。
// 助手那一侧还有一份底线名单（apps/computer-use-win 的 baseline.rs），WIN_BASELINE 是它的每一项，这里都要禁止。
import type { AppRisk } from './policy.mjs'

/** 认一个 Windows 应用要的几样（listApps 给的，或者 getAppState 的 app） */
export interface WinAppIdentity {
  appId: string
  name: string
  exe?: string | null
  aumid?: string | null
  originalFilename?: string | null
}

/** 助手的底线名单（baseline.rs 的 FORBIDDEN_EXES）：Litch 自身与助手、凭据与提权界面、锁屏 */
export const WIN_BASELINE: readonly string[] = [
  'litch.exe',
  'litch-computer-use.exe',
  'consent.exe',
  'credentialuibroker.exe',
  'logonui.exe',
  'lockapp.exe',
]

const FORBIDDEN_EXES = new Set([
  ...WIN_BASELINE,
  // 系统设置与管理工具
  'systemsettings.exe',
  'systemsettingsadminflows.exe',
  'control.exe',
  'regedit.exe',
  'regedt32.exe',
  'gpedit.exe',
  'mmc.exe',
  'services.exe',
  'taskschd.exe',
  'taskmgr.exe',
  'useraccountcontrolsettings.exe',
  'netplwiz.exe',
  'secpol.exe',
  'lusrmgr.exe',
  'compmgmtlauncher.exe',
  'msconfig.exe',
  'credwiz.exe',
  'sethc.exe',
  'utilman.exe',
  // Windows 安全中心、Defender
  'securityhealthui.exe',
  'securityhealthsystray.exe',
  'securityhealthhost.exe',
  'msascuil.exe',
  'msascui.exe',
  'mpcmdrun.exe',
  'smartscreen.exe',
  // 常见杀毒软件的界面
  'avastui.exe',
  'avgui.exe',
  'mcuicnt.exe',
  'mcafee.exe',
  'nortonui.exe',
  'avpui.exe',
  'avp.exe',
  'egui.exe',
  'bdagent.exe',
  'seccenter.exe',
  'mbam.exe',
  'malwarebytes.exe',
  'sophosui.exe',
  'uiseagnt.exe',
  'psuamain.exe',
  'kav.exe',
  'mcshield.exe',
  // 密码管理器
  '1password.exe',
  'bitwarden.exe',
  'keepass.exe',
  'keepassxc.exe',
  'lastpass.exe',
  'dashlane.exe',
  'keeperpasswordmanager.exe',
  'nordpass.exe',
  'protonpass.exe',
  'proton pass.exe',
  'enpass.exe',
  'roboform.exe',
  // 官方的 ChatGPT / Codex 桌面端
  'chatgpt.exe',
  'codex.exe',
])

/** AUMID（不分大小写）以这些开头的禁止：打包的系统设置、安全中心、密码管理器、官方桌面端、Litch */
const FORBIDDEN_AUMID_PREFIXES = [
  'windows.immersivecontrolpanel_',
  'microsoft.sechealthui_',
  'microsoft.windows.sechealthui_',
  'microsoft.windows.lockapp_',
  'agilebits.1password',
  '8bitsolutionsllc.bitwarden',
  'bitwarden.',
  'keepersecurity',
  'nordsecurity.nordpass',
  'proton.protonpass',
  'sinew.enpass',
  'openai.chatgpt',
  'openai.codex',
  'io.github.slovx2.litch',
]

/** 显示名里带这些的当密码管理器 */
const FORBIDDEN_NAME_WORDS = ['password', '密码', 'keepass', 'bitwarden', 'credential manager']

const ELEVATED_EXES = new Set([
  // 浏览器
  'msedge.exe',
  'chrome.exe',
  'chromium.exe',
  'firefox.exe',
  'brave.exe',
  'opera.exe',
  'vivaldi.exe',
  'arc.exe',
  'iexplore.exe',
  'waterfox.exe',
  'librewolf.exe',
  'floorp.exe',
  'zen.exe',
  'thorium.exe',
  'yandex.exe',
  'comet.exe',
  // 终端与命令行
  'windowsterminal.exe',
  'wt.exe',
  'openconsole.exe',
  'conhost.exe',
  'cmd.exe',
  'powershell.exe',
  'powershell_ise.exe',
  'pwsh.exe',
  'mintty.exe',
  'git-bash.exe',
  'bash.exe',
  'wsl.exe',
  'wslhost.exe',
  'ubuntu.exe',
  'debian.exe',
  'alacritty.exe',
  'wezterm-gui.exe',
  'hyper.exe',
  'tabby.exe',
  'warp.exe',
  'cmder.exe',
  'conemu.exe',
  'conemu64.exe',
  'putty.exe',
  // 文件资源管理器（地址栏能直接跑命令）
  'explorer.exe',
  // 能直接跑脚本的宿主
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
])

const ELEVATED_AUMID_PREFIXES = [
  'microsoft.windowsterminal',
  'microsoft.powershell',
  'microsoft.microsoftedge',
  'canonicalgrouplimited.',
  'thebrowsercompany.arc',
]

/** 路径或文件名 → 小写的文件名 */
export function exeName(path: string | null | undefined): string {
  if (!path) return ''
  const parts = path.split(/[\\/]/)
  return (parts[parts.length - 1] ?? '').trim().toLowerCase()
}

/** AUMID 只认“包族名!应用号”这种样子，路径不是 */
function aumidOf(app: WinAppIdentity): string {
  const aumid = app.aumid ?? (app.appId.includes('!') ? app.appId : '')
  return aumid.trim().toLowerCase()
}

export function classifyWinApp(app: WinAppIdentity): AppRisk {
  const names = [exeName(app.exe), exeName(app.originalFilename)]
  if (!app.appId.includes('!')) names.push(exeName(app.appId))
  const files = names.filter((name) => name !== '')
  const aumid = aumidOf(app)
  if (files.some((name) => FORBIDDEN_EXES.has(name))) return 'forbidden'
  if (aumid && FORBIDDEN_AUMID_PREFIXES.some((prefix) => aumid.startsWith(prefix))) {
    return 'forbidden'
  }
  const name = app.name.toLowerCase()
  if (FORBIDDEN_NAME_WORDS.some((word) => name.includes(word))) return 'forbidden'
  if (files.some((file) => ELEVATED_EXES.has(file))) return 'elevated'
  if (aumid && ELEVATED_AUMID_PREFIXES.some((prefix) => aumid.startsWith(prefix))) {
    return 'elevated'
  }
  return 'normal'
}

/** 测试用 */
export const WIN_LISTS_FOR_TEST = { forbidden: FORBIDDEN_EXES, elevated: ELEVATED_EXES }
