// 把密码库装进主进程：safeStorage 做加密器、建库、接上设置页的消息和自动填充。browser/install.mts 调一次，
// 拿回来的库交给导入管线（它的 importMany 就是 PasswordSink）。
import { type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, safeStorage } from 'electron'
import { installAutofill } from './autofill.mjs'
import {
  PASSWORDS_CHANGED,
  PASSWORDS_LIST,
  PASSWORDS_REMOVE,
  PASSWORDS_REMOVE_ALL,
} from './ipc.mjs'
import {
  createPasswordStore,
  type PasswordCipher,
  type PasswordStore,
  passwordsFile,
} from './store.mjs'

/**
 * safeStorage：macOS 是钥匙串里应用自己的那把钥匙，Windows 是 DPAPI。Linux 上退到 basic_text 时等于没加密，
 * 当不可用
 */
const safeStorageCipher: PasswordCipher = {
  available() {
    if (!safeStorage.isEncryptionAvailable()) return false
    return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
  },
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (sealed) => safeStorage.decryptString(Buffer.from(sealed, 'base64')),
}

export function installPasswords(options: {
  userData: string
  /** 是不是界面自己的主框架发来的（browser/install.mts 的 fromUi） */
  fromUi(event: IpcMainEvent | IpcMainInvokeEvent): boolean
  /** 推给所有窗口 */
  broadcast(channel: string, payload: unknown): void
}): PasswordStore {
  const store = createPasswordStore({
    file: passwordsFile(options.userData),
    cipher: safeStorageCipher,
    log: (line) => console.error(`[passwords] ${line}`),
  })
  store.onChange(() => options.broadcast(PASSWORDS_CHANGED, null))
  installAutofill(store)

  ipcMain.handle(PASSWORDS_LIST, (event) => (options.fromUi(event) ? store.list() : []))
  ipcMain.handle(PASSWORDS_REMOVE, (event, id: unknown) => {
    if (!options.fromUi(event) || typeof id !== 'string') return false
    return store.remove(id)
  })
  ipcMain.handle(PASSWORDS_REMOVE_ALL, (event) => (options.fromUi(event) ? store.removeAll() : 0))
  return store
}
