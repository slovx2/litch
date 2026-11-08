// 只有这个显式入口加载 Electron；Node/CDP 使用方不需要 Electron 进程。

export { restoreBrowserCookies } from './browser/cookie-session.mjs'
export type { ElectronBrowserHost, Rect } from './browser/electron-host.mjs'
export { createElectronHost } from './browser/electron-host.mjs'
export { installAutofill } from './browser/passwords/autofill.mjs'
export type { HandoverOptions } from './browser/passwords/handover.mjs'
export { createHandover } from './browser/passwords/handover.mjs'
export { createSavePrompts } from './browser/passwords/prompts.mjs'
export { createSignIns } from './browser/passwords/signin.mjs'
export { electronCookieJar } from './browser-import/cookie-jar.mjs'
