// 访问范围“禁止常用敏感位置”的内置名单。以 ~ 开头的是主目录下的。
// 设置页显示它，切到“自定义”时从它抄一份起步。改名单就改这里，随版本更新。
import type { MachineFacts } from './types.mjs'
import { windowsSystem } from './windows-paths.mjs'

export const SENSITIVE_PRESETS: readonly string[] = [
  '~/.ssh',
  '~/.gnupg',
  '~/Library/Keychains',
  // 邮件、信息、通讯录、日历（V2 实测：经本机设备服务起的命令读得到，不弹授权框）
  '~/Library/Mail',
  '~/Library/Messages',
  '~/Library/Application Support/AddressBook',
  '~/Library/Calendars',
  // 浏览器的资料（Cookie、保存的密码）
  '~/Library/Application Support/Google/Chrome',
  '~/Library/Application Support/Firefox',
  '~/Library/Application Support/Microsoft Edge',
  '~/Library/Application Support/BraveSoftware',
  '~/Library/Application Support/Arc',
  '~/Library/Safari',
  '~/Library/Cookies',
  // Litch 自己的设置和状态：桌面端的用户数据，以及设备服务的状态目录（设置里有各 harness 的环境变量和密钥，
  // 改了它就能改本机 harness 的启动方式）
  '~/Library/Application Support/Litch',
  '~/.codex-harness-adapter',
  // 各 harness 和常用命令行的登录凭据
  '~/.codex/auth.json',
  '~/.claude/.credentials.json',
  '~/.config/gh',
  '~/.aws',
  '~/.docker/config.json',
  '~/.kube/config',
  '~/.netrc',
  '~/.npmrc',
]

/** Windows 的凭据、浏览器资料和 harness 配置；AppData 按外壳给的真实目录展开。 */
export function sensitivePresets(
  facts?: Pick<MachineFacts, 'system' | 'appData' | 'localAppData'>,
): readonly string[] {
  if (!facts || !windowsSystem(facts.system)) return SENSITIVE_PRESETS
  const roaming = (facts.appData ?? '~/AppData/Roaming').replace(/\\/g, '/')
  const local = (facts.localAppData ?? '~/AppData/Local').replace(/\\/g, '/')
  return [
    '~/.ssh',
    '~/.gnupg',
    `${roaming}/Microsoft/Credentials`,
    `${local}/Microsoft/Credentials`,
    `${roaming}/Microsoft/Protect`,
    `${roaming}/Microsoft/Vault`,
    `${local}/Microsoft/Vault`,
    `${roaming}/Microsoft/Crypto`,
    `${local}/Google/Chrome/User Data`,
    `${local}/Microsoft/Edge/User Data`,
    `${roaming}/Mozilla/Firefox`,
    `${local}/Mozilla/Firefox`,
    `${local}/BraveSoftware`,
    `${roaming}/Opera Software`,
    `${local}/Microsoft/Outlook`,
    `${local}/Packages/microsoft.windowscommunicationsapps_8wekyb3d8bbwe`,
    `${roaming}/Litch`,
    '~/.codex-harness-adapter',
    '~/.codex',
    '~/.claude',
    '~/.claude.json',
    '~/.pi',
    '~/.dsh',
    '~/.config/opencode',
    '~/.local/share/opencode',
    `${roaming}/codex`,
    `${roaming}/claude`,
    `${roaming}/pi`,
    `${roaming}/dsh`,
    `${roaming}/opencode`,
    '~/.config/gh',
    `${roaming}/GitHub CLI`,
    '~/.aws',
    '~/.docker/config.json',
    '~/.kube/config',
    '~/.netrc',
    '~/_netrc',
    '~/.npmrc',
  ]
}
