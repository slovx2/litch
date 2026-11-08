// 平台交接负责清理旧文档；它必须在代理被冻结或取消后继续执行，不能经过代理动作的闸门。
import type { WebContents } from 'electron'
import type { HostTab } from '../electron-tab.mjs'
import type { BrowserHost, BrowserPage } from '../model.mjs'

/** 换成新文档才成功；204、导航失败或标签已被替换都不能当成安全交还。 */
export async function refreshHandoverPage(
  host: BrowserHost,
  requested: BrowserPage,
  contents: WebContents,
  timeoutMs: number,
): Promise<boolean> {
  // requested 可能是执行器的 guardedPage；只在宿主内部取回同一 WebContents 的原始标签。
  // 不解除冻结，也不让代理调用绕过停止、来源审批或文档检查。
  const page = host.page(requested.id) as HostTab | undefined
  if (!page || page.view.webContents !== contents || contents.isDestroyed()) return false
  let navigated = false
  const on = () => {
    navigated = true
  }
  const allow = (event: Electron.Event) => event.preventDefault()
  contents.on('did-navigate', on)
  contents.on('will-prevent-unload', allow)
  try {
    const url = contents.getURL()
    // HTTP 用 GET 重开，不重提 POST；about:blank 等地址沿用原来的 reload 行为。
    if (/^https?:\/\//i.test(url)) await page.load(url, timeoutMs)
    else await page.history('reload', timeoutMs)
    return navigated && !contents.isDestroyed() && host.page(requested.id) === page
  } catch {
    return false
  } finally {
    if (!contents.isDestroyed()) {
      contents.removeListener('did-navigate', on)
      contents.removeListener('will-prevent-unload', allow)
    }
  }
}
