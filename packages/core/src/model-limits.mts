// 账号的用量额度在界面这一头的样子（account/rateLimits/read 投影过来的）。
// 只有订阅登录的账号有：Codex 的 ChatGPT 登录、Claude Code 的 Anthropic 订阅登录。
// 用 API key、第三方 provider 的，和不认识这个方法的 harness，rows 是空的。

/** 一个额度窗口 */
export interface AccountLimitWindow {
  /** 用了百分之几，整数，可以超过 100 */
  usedPercent: number
  /** 窗口多长（分钟）：300 是 5 小时，10080 是一周。对面没说是 null */
  windowMins: number | null
  /** 什么时候重置（毫秒时间戳）。对面没说是 null */
  resetsAt: number | null
}

/** 一行额度 */
export interface AccountLimitRow {
  /** 这一行的标识：额度的 limitId 加窗口（primary、secondary） */
  id: string
  /** 主额度的两个窗口是 null；别的额度（按模型分的周额度等）是对面给的名字 */
  name: string | null
  window: AccountLimitWindow
}

/** 一台设备上一个 harness 的账号额度（accountLimits 主题） */
export interface AccountLimitsView {
  deviceId: string
  harness: string
  /** 主额度的窗口在前（短的在前），别的额度跟在后面。没有额度是空的 */
  rows: AccountLimitRow[]
}
