// 全部页面和各自的参数，是页面之间互相跳转的约定，改这里要连带看所有用到它的页面。参数只放标识和少量首帧要用的字（标题），数据一律从核心订阅，不经路由传。
import type { DiffScope } from '@litch/core'

export type RootStackParamList = {
  /** 首页：设备列表。每台设备一行（连接状态、忙闲、待处理数），点进去是这台设备的会话 */
  Devices: undefined
  /** 加一台设备：填主机、端口、用户，生成或导入密钥，核对主机指纹 */
  AddDevice: undefined
  /** 扫码添加：扫电脑上的配对二维码或者粘贴配对文本，确认后登记并添加。配对文本是秘密，不经路由传 */
  PairDevice: undefined
  /** 一台设备的详情：连接信息、密钥、重连、去掉；harness 的启用和设置（设备有设置接口时） */
  DeviceDetail: { deviceId: string }
  /** 一台设备上一个 harness 的详情设置：配置、账号（登录、API key、provider）、MCP 与指令文件（只读）。name 是 harness 的名字，首帧就画 */
  HarnessSettings: { deviceId: string; harness: string; name?: string }
  /** 一台设备上的工作区和会话（相当于桌面端侧栏里这台设备的那一段），含已归档 */
  Sessions: { deviceId: string }
  /**
   * 新会话：选 harness、工作区或目录、模型和权限，写第一条消息。发出去之后换成详情页。
   * workspaceId 是 null 时建不属于项目的会话；不给就从上次在这台设备上的位置开始
   */
  NewSession: { deviceId: string; workspaceId?: string | null }
  /** 会话详情。title 是列表里那一行的标题，首帧就画出来（F1） */
  Detail: { deviceId: string; sessionId: string; title?: string }
  /** 一个会话里的建议任务（模型提的子会话提案）：等着的在上、了结的在下，点一条回到对话里那张卡片。title 是会话名，首帧就画 */
  Proposals: { deviceId: string; sessionId: string; title?: string }
  /** 提案的“改了再开始”：照提案预填，harness、模型、强度、项目、目录、权限、全新还是带上下文、标题、简报、完成后唤醒都能改 */
  ProposalStart: { deviceId: string; sessionId: string; proposalId: string }
  /** 终端。root 是开在哪个目录（工作区的根或会话的工作目录）；terminalId 给了就直接打开那一个 */
  Terminal: { deviceId: string; root: string | null; terminalId?: string }
  /** 未提交的改动：文件列表和逐个文件的差异 */
  Diff: { deviceId: string; root: string; scope: DiffScope; sessionId: string | null }
  /** 文件：浏览一个根下面的目录、看文件内容。path 是完整路径，是目录就列它，是文件就打开看；line 是打开后定位到第几行（从 1 起，对话区里的文件引用会带） */
  Files: { deviceId: string; root: string; path?: string; line?: number }
  /** 定时任务：按设备分组列出（名字、日程、下一次、最近一次、没看过的运行）。deviceId 给了只列这一台 */
  Tasks: { deviceId?: string }
  /** 新建或编辑一个定时任务。taskId 给了是编辑；sessionId 给了是新建“在这个会话里接着发”的任务 */
  TaskEdit: { deviceId: string; taskId?: string; sessionId?: string }
  /** 一个定时任务的详情：立即运行、暂停继续、编辑、删除，运行记录（点进会话）。title 是任务名，首帧就画 */
  TaskDetail: { deviceId: string; taskId: string; title?: string }
  /** 应用设置：语言、明暗、关于 */
  Settings: undefined
  /** 开发用：WebView 吞吐测试（scripts/bench.mjs 的 webview 场景） */
  Bench: undefined
}

export type RouteName = keyof RootStackParamList
