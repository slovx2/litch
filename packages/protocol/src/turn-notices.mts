// 桌面与手机共用的通知摘要；只走声明了 turnNotices 的设备连接，不替代标准生命周期通知。
export const TURN_NOTICE = 'litch/thread/turn/notice'
export const TURN_NOTICE_BODY_MAX = 500

export interface TurnNotice {
  threadId: string
  turnId: string
  outcome: 'completed' | 'failed' | 'interrupted'
  /** 最后一条回答（失败时为错误原因）的 Markdown 开头，最多 500 个 Unicode 码点。 */
  body: string | null
}
