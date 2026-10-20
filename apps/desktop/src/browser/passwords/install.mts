// 把密码库装进主进程：safeStorage 做加密器、建库、接上设置页的消息、自动填充和登录后的保存提示。
// browser/install.mts 调一次，拿回来的库交给导入管线（它的 importMany 就是 PasswordSink）。
import { type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, safeStorage } from 'electron'
import { installAutofill } from './autofill.mjs'
import {
  PASSWORDS_ALLOW_SITE,
  PASSWORDS_ANSWER,
  PASSWORDS_CHANGED,
  PASSWORDS_LIST,
  PASSWORDS_NEVER,
  PASSWORDS_PROMPTS,
  PASSWORDS_PROMPTS_CHANGED,
  PASSWORDS_REMOVE,
  PASSWORDS_REMOVE_ALL,
} from './ipc.mjs'
import { createSavePrompts, type PromptAnswer } from './prompts.mjs'
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

const ANSWERS: readonly PromptAnswer[] = ['save', 'dismiss', 'never']

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
  // 保存提示只推给界面（所有窗口），不给代理
  const prompts = createSavePrompts({ store })
  prompts.onChange((list) => options.broadcast(PASSWORDS_PROMPTS_CHANGED, list))
  installAutofill(store, prompts)

  ipcMain.handle(PASSWORDS_LIST, (event) => (options.fromUi(event) ? store.list() : []))
  ipcMain.handle(PASSWORDS_REMOVE, (event, id: unknown) => {
    if (!options.fromUi(event) || typeof id !== 'string') return false
    return store.remove(id)
  })
  ipcMain.handle(PASSWORDS_REMOVE_ALL, (event) => (options.fromUi(event) ? store.removeAll() : 0))
  ipcMain.handle(PASSWORDS_NEVER, (event) => (options.fromUi(event) ? store.neverSites() : []))
  ipcMain.handle(PASSWORDS_ALLOW_SITE, (event, origin: unknown) => {
    if (!options.fromUi(event) || typeof origin !== 'string') return false
    return store.removeNever(origin)
  })
  ipcMain.handle(PASSWORDS_PROMPTS, (event) => (options.fromUi(event) ? prompts.list() : []))
  ipcMain.handle(PASSWORDS_ANSWER, (event, payload: unknown) => {
    if (!options.fromUi(event)) return false
    const { id, answer } = (payload ?? {}) as { id?: unknown; answer?: unknown }
    if (typeof id !== 'string' || !ANSWERS.includes(answer as PromptAnswer)) return false
    return prompts.answer(id, answer as PromptAnswer)
  })
  return store
}
