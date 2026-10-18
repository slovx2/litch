// 哪些应用不许操作、哪些算高风险，按桌面的平台分派：macOS 的名单在 policy-mac.mts（按包标识），
// Windows 的在 policy-win.mts（按 exe 文件名、OriginalFilename、AUMID）。执行器只认这里的 classifyApp。
import { classifyMacApp } from './policy-mac.mjs'
import { classifyWinApp, type WinAppIdentity } from './policy-win.mjs'

/** forbidden：当场拒绝、不弹卡片；elevated：卡片上标高风险；normal：照常问 */
export type AppRisk = 'forbidden' | 'elevated' | 'normal'

/** 一个应用，两个平台给的样子 */
export type ClassifiedApp =
  | { platform: 'darwin'; bundleId: string | null; name: string }
  | ({ platform: 'win32' } & WinAppIdentity)

export function classifyApp(app: ClassifiedApp): AppRisk {
  return app.platform === 'win32' ? classifyWinApp(app) : classifyMacApp(app)
}
