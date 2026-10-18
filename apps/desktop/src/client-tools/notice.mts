// litch_machine 的系统通知（08 号设计 4.2）：远程设备上一个找不到会话的命令行调用要用户点头时，卡片进了顶栏的
// 全局待处理，同时在这里发一条系统通知，免得用户不在 Litch 的窗口前就一直没人答。
// 文字按界面的语言拼（核心不认识语言，只给结构）。点通知把窗口叫到前面，答在窗口里答。
import { Notification } from 'electron'
import type { MachineNotice } from './types.mjs'

export type NoticeLang = 'zh-CN' | 'en'

/** 通知里的命令、路径最多显示多少个字 */
const SUMMARY_MAX = 120

const clip = (text: string): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1)}…` : line
}

const ACTIONS: Record<NoticeLang, Record<MachineNotice['action'], string>> = {
  'zh-CN': {
    exec: '想在这台电脑上运行命令',
    write: '想在这台电脑上写文件',
    read: '想读这台电脑上的文件',
    list: '想看这台电脑上的目录',
    copy: '想在两台机器之间复制文件',
    process: '想操作这台电脑上的进程',
  },
  en: {
    exec: 'wants to run a command on this computer',
    write: 'wants to write a file on this computer',
    read: 'wants to read a file on this computer',
    list: 'wants to list a folder on this computer',
    copy: 'wants to copy files between machines',
    process: 'wants to control a process on this computer',
  },
}

/** 通知的标题和正文 */
export function noticeText(
  notice: MachineNotice,
  lang: NoticeLang,
): { title: string; body: string } {
  const who = notice.deviceName || notice.host
  const action = ACTIONS[lang][notice.action] ?? ACTIONS[lang].exec
  const title = `${who} ${action}`
  const tail =
    lang === 'zh-CN'
      ? '来自一个命令行调用（不知道是哪个会话），到 Litch 里确认。'
      : 'From a command-line call (session unknown). Review it in Litch.'
  const summary = clip(notice.summary)
  return { title, body: summary ? `${summary}\n${tail}` : tail }
}

/** 发一条通知。系统不支持通知时什么都不做；点了调 onClick（把窗口叫到前面） */
export function showMachineNotice(
  notice: MachineNotice,
  lang: NoticeLang,
  onClick: () => void,
): void {
  if (!Notification.isSupported()) return
  const { title, body } = noticeText(notice, lang)
  const shown = new Notification({ title, body })
  shown.on('click', onClick)
  shown.show()
}
