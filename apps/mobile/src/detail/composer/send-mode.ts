// 回合进行中发的消息：立即发送（session.send 带 now，插进正在进行的回合）还是排队。判断和桌面是同一份
// （packages/ui/src/composer/send-mode-logic.ts）：选了立即发送而这个会话插不了话的，照样排队。
// 这一项记在手机本地 prefs.json 的 sendMode（src/shell/services.tsx），设置页“对话”一组里改。
import {
  DEFAULT_SEND_MODE,
  type RunningSend,
  runningSend,
  SEND_MODES,
  type SendMode,
} from '../../../../../packages/ui/src/composer/send-mode-logic.ts'

/** prefs.json 里存着的那一项：没有的、认不得的都按默认（立即发送） */
export function sendModeOf(saved: unknown): SendMode {
  return SEND_MODES.find((mode) => mode === saved) ?? DEFAULT_SEND_MODE
}

/** 这个会话回合进行中按下发送会怎样。会话还没到时先当插得了（和桌面一样），插不进去的核心照常排着 */
export const whenRunning = (mode: SendMode, can: { steer?: boolean } | undefined): RunningSend =>
  runningSend(mode, can?.steer !== false)

/** session.send 要多带的：要插进去才带 now（没有回合在跑时核心不看它） */
export const sendFlags = (send: RunningSend): { now?: true } =>
  send === 'steer' ? { now: true } : {}
