// 登录卡片在界面那一头：列卡片、答（代填、自己登录、交还、拒绝、知道了），变了推给所有窗口；
// 以及“代填前要 Touch ID”（设置页内置浏览器“已保存的密码”下的开关，默认关，只有 macOS 有）。
// 对话里的那张卡片答复也走这里（浏览器桥 signIn.answer），和面板上的同一条路。手机的答复不走这里（handover.mts 验签）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  app,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  ipcMain,
  systemPreferences,
} from 'electron'
import {
  SIGNIN_ANSWER,
  SIGNIN_CHANGED,
  SIGNIN_LIST,
  SIGNIN_SET_TOUCH_ID,
  SIGNIN_TOUCH_ID,
} from './ipc.mjs'
import type { SignInAnswer, SignIns } from './signin.mjs'

/** 界面送来的回答：done、cancel、dismiss、self，或 { fill: ref, remember } */
export function parseSignInAnswer(answer: unknown): SignInAnswer | null {
  if (answer === 'done' || answer === 'cancel' || answer === 'dismiss' || answer === 'self') {
    return answer
  }
  if (!answer || typeof answer !== 'object') return null
  const { fill, remember } = answer as { fill?: unknown; remember?: unknown }
  if (typeof fill !== 'string' || fill === '') return null
  return { fill, remember: remember === true }
}

/** 登录卡片的设置存在这里 */
export const signInSettingsFile = (userData: string) =>
  join(userData, 'browser', 'sign-in-settings.json')

const touchIdAvailable = (): boolean => {
  if (process.platform !== 'darwin') return false
  try {
    return systemPreferences.canPromptTouchID()
  } catch {
    return false
  }
}

const WORDS = {
  'zh-CN': '用已保存的密码登录网站',
  en: 'sign in to a website with a saved password',
}

export function installSignInIpc(options: {
  signIns: SignIns
  userData: string
  fromUi(event: IpcMainEvent | IpcMainInvokeEvent): boolean
  broadcast(channel: string, payload: unknown): void
}): void {
  const { signIns } = options
  const file = signInSettingsFile(options.userData)
  const read = (): boolean => {
    try {
      if (!existsSync(file)) return false
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { touchId?: unknown }
      return parsed.touchId === true
    } catch {
      return false
    }
  }
  const write = (on: boolean) => {
    mkdirSync(dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    writeFileSync(temp, `${JSON.stringify({ touchId: on }, null, 2)}\n`)
    renameSync(temp, file)
  }
  const state = () => {
    const available = touchIdAvailable()
    return { available, on: available && read() }
  }

  signIns.onChange((list) => options.broadcast(SIGNIN_CHANGED, list))
  ipcMain.handle(SIGNIN_LIST, (event) => (options.fromUi(event) ? signIns.list() : []))
  ipcMain.handle(SIGNIN_ANSWER, async (event, payload: unknown) => {
    if (!options.fromUi(event)) return false
    const { id, answer } = (payload ?? {}) as { id?: unknown; answer?: unknown }
    if (typeof id !== 'string') return false
    const parsed = parseSignInAnswer(answer)
    if (!parsed) return false
    // 代填前要过 Touch ID（开着的话）：没过就当没答，卡片接着等
    if (typeof parsed === 'object' && state().on) {
      const card = signIns.get(id)
      if (card?.stage !== 'choose') return false
      try {
        await systemPreferences.promptTouchID(
          WORDS[app.getLocale().startsWith('zh') ? 'zh-CN' : 'en'],
        )
      } catch {
        return false
      }
    }
    return signIns.answer(id, parsed)
  })
  ipcMain.handle(SIGNIN_TOUCH_ID, (event) =>
    options.fromUi(event) ? state() : { available: false, on: false },
  )
  ipcMain.handle(SIGNIN_SET_TOUCH_ID, (event, on: unknown) => {
    if (!options.fromUi(event) || typeof on !== 'boolean') return state()
    if (touchIdAvailable()) write(on)
    return state()
  })
}
