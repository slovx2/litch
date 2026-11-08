// 七个来源在 Mac、Windows 上的资料放在哪。只按平台和主目录算出候选路径，测试里可以换成假的主目录。
// 别的平台（Linux 等）一个都不列（同官方）。
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { BrowserFamily, BrowserId } from './types.mjs'

/** 算路径用到的环境。测试和样本模式里整份换掉，产品里用 currentEnv() */
export interface ImportEnv {
  platform: NodeJS.Platform
  home: string
  /** Windows 的 %LOCALAPPDATA%（Chromium 系的资料在这里） */
  localAppData?: string
  /** Windows 的 %APPDATA%（Firefox 的资料在这里） */
  appData?: string
}

export function currentEnv(): ImportEnv {
  const env: ImportEnv = { platform: process.platform, home: homedir() }
  if (process.env.LOCALAPPDATA) env.localAppData = process.env.LOCALAPPDATA
  if (process.env.APPDATA) env.appData = process.env.APPDATA
  return env
}

/** 样本模式（LITCH_BROWSER_IMPORT_FAKE）：样本目录当主目录，Windows 的两个目录也在它下面 */
export function sampleEnv(dir: string, platform: NodeJS.Platform = process.platform): ImportEnv {
  return {
    platform,
    home: dir,
    localAppData: join(dir, 'AppData', 'Local'),
    appData: join(dir, 'AppData', 'Roaming'),
  }
}

export interface BrowserDef {
  browser: BrowserId
  /** 产品名，不翻译 */
  name: string
  family: BrowserFamily
}

export const BROWSERS: readonly BrowserDef[] = [
  { browser: 'chrome', name: 'Google Chrome', family: 'chromium' },
  { browser: 'edge', name: 'Microsoft Edge', family: 'chromium' },
  { browser: 'brave', name: 'Brave', family: 'chromium' },
  { browser: 'arc', name: 'Arc', family: 'chromium' },
  { browser: 'chromium', name: 'Chromium', family: 'chromium' },
  { browser: 'vivaldi', name: 'Vivaldi', family: 'chromium' },
  { browser: 'firefox', name: 'Firefox', family: 'firefox' },
]

export const browserDef = (browser: BrowserId): BrowserDef | undefined =>
  BROWSERS.find((item) => item.browser === browser)

/** macOS：~/Library/Application Support 下的目录 */
const MAC_CHROMIUM: Record<Exclude<BrowserId, 'firefox'>, string[]> = {
  chrome: ['Google', 'Chrome'],
  edge: ['Microsoft Edge'],
  brave: ['BraveSoftware', 'Brave-Browser'],
  arc: ['Arc', 'User Data'],
  chromium: ['Chromium'],
  vivaldi: ['Vivaldi'],
}

/** Windows：%LOCALAPPDATA% 下的 User Data。Arc 是商店包，另外找（winPackageDirs） */
const WIN_CHROMIUM: Record<Exclude<BrowserId, 'firefox' | 'arc'>, string[]> = {
  chrome: ['Google', 'Chrome', 'User Data'],
  edge: ['Microsoft', 'Edge', 'User Data'],
  brave: ['BraveSoftware', 'Brave-Browser', 'User Data'],
  chromium: ['Chromium', 'User Data'],
  vivaldi: ['Vivaldi', 'User Data'],
}

const localOf = (env: ImportEnv) => env.localAppData ?? join(env.home, 'AppData', 'Local')
const roamingOf = (env: ImportEnv) => env.appData ?? join(env.home, 'AppData', 'Roaming')

/**
 * 商店（MSIX）装的应用把数据放在 %LOCALAPPDATA%\Packages\<包名>_<发布者哈希>\LocalCache 下。
 * 发布者哈希不写死，按包名前缀找
 */
function winPackageDirs(env: ImportEnv, packageName: string): string[] {
  const packages = join(localOf(env), 'Packages')
  try {
    return readdirSync(packages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${packageName}_`))
      .map((entry) => join(packages, entry.name, 'LocalCache'))
      .sort()
  } catch {
    return []
  }
}

/** Chromium 系的资料根目录（User Data 那一层）的候选，按顺序取第一个在的 */
export function chromiumRoots(browser: Exclude<BrowserId, 'firefox'>, env: ImportEnv): string[] {
  if (env.platform === 'darwin') {
    return [join(env.home, 'Library', 'Application Support', ...MAC_CHROMIUM[browser])]
  }
  if (env.platform === 'win32') {
    if (browser === 'arc') {
      return winPackageDirs(env, 'TheBrowserCompany.Arc').map((cache) =>
        join(cache, 'Local', 'Arc', 'User Data'),
      )
    }
    return [join(localOf(env), ...WIN_CHROMIUM[browser])]
  }
  return []
}

/** Firefox 的 profiles.ini 所在目录的候选，按顺序取第一个有 profiles.ini 的 */
export function firefoxRoots(env: ImportEnv): string[] {
  if (env.platform === 'darwin') {
    return [join(env.home, 'Library', 'Application Support', 'Firefox')]
  }
  if (env.platform === 'win32') {
    return [
      join(roamingOf(env), 'Mozilla', 'Firefox'),
      // 商店装的 Firefox
      ...winPackageDirs(env, 'Mozilla.Firefox').map((cache) =>
        join(cache, 'Roaming', 'Mozilla', 'Firefox'),
      ),
    ]
  }
  return []
}
