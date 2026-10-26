// 定时任务跑完了、会话回合结束或要人处理的系统通知：界面听着核心的通知判断要不要发，
// 拼好文字交给这里，这里只管弹。点了把窗口叫到前面，再告诉界面点的是哪一条，界面去开那个会话。
import { BrowserWindow, Notification, type WebContents } from 'electron'

/** 标题、正文最多多少个字：通知中心里放不下更多 */
const TITLE_MAX = 120
const BODY_MAX = 240

export interface TaskNotice {
  /** 界面自己认的标识，点了原样还回去 */
  id: string
  title: string
  /** 标题下面一行小字（macOS 才显示）：会话在哪个项目、哪台设备上。没有不带 */
  subtitle?: string
  body: string
}

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/** 界面发来的是不是一条像样的通知。别的形状一律不认 */
export function parseTaskNotice(value: unknown): TaskNotice | null {
  const { id, title, subtitle, body } = (value ?? {}) as Record<string, unknown>
  if (typeof id !== 'string' || typeof title !== 'string' || typeof body !== 'string') return null
  if (subtitle !== undefined && typeof subtitle !== 'string') return null
  if (!id || id.length > 200 || !title) return null
  return {
    id,
    title: clip(title, TITLE_MAX),
    ...(subtitle ? { subtitle: clip(subtitle, TITLE_MAX) } : {}),
    body: clip(body, BODY_MAX),
  }
}

/** 还没被点掉、关掉的通知：留着引用，免得被回收之后点了没反应 */
const shown = new Set<Notification>()

/** 弹一条。系统不支持通知时什么都不做；点了叫回窗口，再把 id 发给发它的那个页面 */
export function showTaskNotice(notice: TaskNotice, sender: WebContents, clicked: string): void {
  if (!Notification.isSupported()) return
  const item = new Notification({
    title: notice.title,
    ...(notice.subtitle ? { subtitle: notice.subtitle } : {}),
    body: notice.body,
  })
  shown.add(item)
  item.on('click', () => {
    shown.delete(item)
    const window = BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getAllWindows()[0]
    if (window) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
    if (!sender.isDestroyed()) sender.send(clicked, notice.id)
  })
  item.on('close', () => shown.delete(item))
  item.show()
}
