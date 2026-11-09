// 手动登录卡片只接受交接动作；旧版代填答复直接忽略。
import { type IpcMainEvent, type IpcMainInvokeEvent, ipcMain } from 'electron'
import { SIGNIN_ANSWER, SIGNIN_CHANGED, SIGNIN_LIST } from './ipc.mjs'
import type { SignInAnswer, SignIns } from './signin.mjs'

export function parseSignInAnswer(answer: unknown): SignInAnswer | null {
  return answer === 'done' || answer === 'cancel' || answer === 'dismiss' || answer === 'self'
    ? answer
    : null
}

export function installSignInIpc(options: {
  signIns: SignIns
  userData: string
  fromUi(event: IpcMainEvent | IpcMainInvokeEvent): boolean
  broadcast(channel: string, payload: unknown): void
}): void {
  const { signIns } = options
  signIns.onChange((list) => options.broadcast(SIGNIN_CHANGED, list))
  ipcMain.handle(SIGNIN_LIST, (event) => (options.fromUi(event) ? signIns.list() : []))
  ipcMain.handle(SIGNIN_ANSWER, (event, payload: unknown) => {
    if (!options.fromUi(event)) return false
    const { id, answer } = (payload ?? {}) as { id?: unknown; answer?: unknown }
    const parsed = parseSignInAnswer(answer)
    return typeof id === 'string' && parsed !== null && signIns.answer(id, parsed)
  })
}
