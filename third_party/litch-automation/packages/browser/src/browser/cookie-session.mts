// 私有 about:blank 控制页只访问本分区的 Cookie，不接入代理工具，页面和工具均拿不到凭据。
// Electron cookies API 丢失 CHIPS 分区键；Network 在控制页自己的存储分区中保留完整 Cookie。
import { safeStorage, session, WebContentsView } from 'electron'
import { type BrowserCookie, createBrowserCookieState } from './cookie-state.mjs'
import type { PasswordCipher } from './passwords/store.mjs'

export async function restoreBrowserCookies(options: {
  partition: string
  file: string
  cipher?: PasswordCipher
  warn?(): void
}) {
  const shared = session.fromPartition(options.partition)
  const control = new WebContentsView({
    webPreferences: {
      partition: options.partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  const debug = control.webContents.debugger
  // 附着失败也走状态模块的脱敏错误处理，不阻止应用启动；下次保存可以重试。
  const send = async (method: string, params?: Record<string, unknown>) => {
    if (!debug.isAttached()) debug.attach('1.3')
    return debug.sendCommand(method, params)
  }
  // Storage.getCookies 默认访问应用默认分区，不能用于这里的持久分区。
  const state = await createBrowserCookieState({
    file: options.file,
    cipher: options.cipher ?? {
      available: () =>
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
    },
    jar: {
      read: async () =>
        ((await send('Network.getAllCookies')) as { cookies: BrowserCookie[] }).cookies,
      restore: async (cookie) => {
        await send('Network.setCookies', { cookies: [cookie] })
      },
      flush: () => shared.cookies.flushStore(),
      changed: (listener) => {
        const changed = (
          _event: Electron.Event,
          _cookie: Electron.Cookie,
          _cause: string,
          removed: boolean,
        ) => listener(removed)
        shared.cookies.on('changed', changed)
        return () => {
          shared.cookies.off('changed', changed)
        }
      },
    },
    warn: options.warn ?? (() => {}),
  })
  return {
    ...state,
    dispose() {
      state.dispose()
      control.webContents.close()
    },
  }
}
