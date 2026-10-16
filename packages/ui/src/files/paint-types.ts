// 界面和上色的工作线程之间来回的消息。
import type { SpanNode } from '@litch/core'

export interface PaintRequest {
  id: number
  text: string
  /** 上色库认的语言名 */
  language: string
}

export type PaintReply =
  /** 一批上好色的行：从第 from 行（从 0 起）开始 */
  | { id: number; from: number; lines: SpanNode[][] }
  /** 这一份上完了。painted 为假：上色库不认识这种语言，什么都没上 */
  | { id: number; done: true; painted: boolean }
