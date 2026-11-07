// Litch 的接线入口；实现只在通用浏览器包维护。
import { join } from 'node:path'
import { restoreBrowserCookies as restore } from '../../../../packages/browser/src/browser/cookie-session.mjs'
export function restoreBrowserCookies(userData: string) {
  return restore({
    partition: 'persist:litch-browser',
    file: join(userData, 'browser', 'session-cookies.enc'),
    warn: () => console.error('[browser] 会话 Cookie 保存或恢复失败；未记录凭据'),
  })
}
