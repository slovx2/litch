// 别的会话发来的消息（扩展名 peerMessages）：harness 自己的会话间消息（Claude Code 的本机收件箱：别的 Claude 会话
// 用 SendMessage 发进来）进了对话，是一条用户消息条目，但不是用户打的字。条目上带 `litchPeer` 说是谁发的，
// 客户端画成“来自 X 的消息”，不画成用户自己的话。新增的东西只发给声明了这个扩展的连接；没声明的连接看到的是
// 一条普通的用户消息（正文是对方的原文）。发送方这边，Claude 的 SendMessage 那条工具条目上也带 `litchPeer`，
// 说的是收件方（入口按收件箱地址认出来的）。定义的原文在仓库根目录 protocol/extensions/peer-messages.json。
//
// 这个文件不引用别的文件：各个入口和客户端核心都直接引用它。

/** 发送方的权限档：bypass 是跳过确认（不问就执行工具）的会话，prompting 是会问的 */
export type PeerMode = 'bypass' | 'prompting'

/**
 * userMessage 条目上的 `litchPeer`：这条消息是别的会话发来的，下面说的是发送方。
 * mcpToolCall 条目（Claude 的 SendMessage）上的 `litchPeer`：这条消息发给了别的会话，下面说的是收件方
 */
export interface LitchPeer {
  /**
   * 显示名：对方是这台设备上的 Litch 会话时是它的标题，否则是对方自报的名字（只用来显示）。
   * 直接写收件箱的外部进程没有
   */
  name?: string
  /**
   * 发送方宿主里的会话号（发送方自报，只当导航目标）：Claude 桌面端的会话是 `local_<uuid>`，
   * 云端会话是 `session_…`。没有时不带
   */
  session?: string
  /** 对方是这台设备上的 Litch 会话时，它在 Litch 里的会话号（入口按本机的进程登记认出来的，只当导航目标） */
  thread?: string
  /** 发送方声明的权限档，没声明时不带（收件方那边没有这一项） */
  mode?: PeerMode
}
