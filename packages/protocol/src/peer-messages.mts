// 别的会话发来的消息（扩展名 peerMessages）：harness 自己的会话间消息（Claude Code 的本机收件箱：别的 Claude 会话
// 用 SendMessage 发进来）进了对话，是一条用户消息条目，但不是用户打的字。条目上带 `litchPeer` 说是谁发的，
// 客户端画成“来自 X 的消息”，不画成用户自己的话。新增的东西只发给声明了这个扩展的连接；没声明的连接看到的是
// 一条普通的用户消息（正文是对方的原文）。定义的原文在仓库根目录 protocol/extensions/peer-messages.json。
//
// 这个文件不引用别的文件：各个入口和客户端核心都直接引用它。

/** 发送方的权限档：bypass 是跳过确认（不问就执行工具）的会话，prompting 是会问的 */
export type PeerMode = 'bypass' | 'prompting'

/** userMessage 条目上的 `litchPeer`：这条消息是别的会话发来的 */
export interface LitchPeer {
  /** 发送方的显示名（发送方自报，只用来显示）。直接写收件箱的外部进程没有 */
  name?: string
  /**
   * 发送方宿主里的会话号（发送方自报，只当导航目标）：Claude 桌面端的会话是 `local_<uuid>`，
   * 云端会话是 `session_…`。没有时不带
   */
  session?: string
  /** 发送方声明的权限档，没声明时不带 */
  mode?: PeerMode
}
