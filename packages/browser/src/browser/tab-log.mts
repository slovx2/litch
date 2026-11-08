// 一个标签攒给代理看的控制台消息和提示（被拦的地址、弹窗地址、页面崩了）。electron-tab.mts 用，单独放出来好不起 Electron 测。
// quiet() 为真的这段时间（交给人登录，passwords/tabs.mts 的 isHandedOver）一概不收：网页这时打的日志、
// 跳去的地址都可能带着人输的字。交还前 passwords/handover.mts 再把攒下的整个清一遍。
import type { ConsoleEntry } from './model.mjs'

const CONSOLE_KEEP = 200
const NOTICES_KEEP = 20

export interface TabLog {
  console(entry: ConsoleEntry): void
  notice(text: string): void
  consoleEntries(): ConsoleEntry[]
  clearConsole(): void
  /** 取走还没给代理的提示 */
  takeNotices(): string[]
}

export function createTabLog(quiet: () => boolean): TabLog {
  let entries: ConsoleEntry[] = []
  let notices: string[] = []
  return {
    console(entry) {
      if (quiet()) return
      entries.push(entry)
      if (entries.length > CONSOLE_KEEP) entries = entries.slice(-CONSOLE_KEEP)
    },
    notice(text) {
      if (quiet()) return
      notices.push(text)
      if (notices.length > NOTICES_KEEP) notices = notices.slice(-NOTICES_KEEP)
    },
    consoleEntries: () => [...entries],
    clearConsole() {
      entries = []
    },
    takeNotices() {
      const taken = notices
      notices = []
      return taken
    },
  }
}
