// 全部页面和各自的参数。这是各条开发线之间的约定：页面归谁写见 design/harness-client/06-mobile-plan.md 第三节，
// 改这里要先和其他线对齐。参数只放标识和少量首帧要用的字（标题），数据一律从核心订阅，不经路由传。
import type { DiffScope } from '@litch/core'

export type RootStackParamList = {
  /** 首页：设备列表。每台设备一行（连接状态、忙闲、待处理数），点进去是这台设备的会话 */
  Devices: undefined
  /** 加一台设备：填主机、端口、用户，生成或导入密钥，核对主机指纹 */
  AddDevice: undefined
  /** 一台设备的详情：连接信息、密钥、重连、去掉；harness 的启用和设置（设备有设置接口时） */
  DeviceDetail: { deviceId: string }
  /** 一台设备上的工作区和会话（相当于桌面端侧栏里这台设备的那一段），含已归档 */
  Sessions: { deviceId: string }
  /** 新会话：选 harness、工作区或目录、模型和权限，写第一条消息。发出去之后换成详情页 */
  NewSession: { deviceId: string; workspaceId?: string }
  /** 会话详情。title 是列表里那一行的标题，首帧就画出来（F1） */
  Detail: { deviceId: string; sessionId: string; title?: string }
  /** 终端。root 是开在哪个目录（工作区的根或会话的工作目录）；terminalId 给了就直接打开那一个 */
  Terminal: { deviceId: string; root: string | null; terminalId?: string }
  /** 未提交的改动：文件列表和逐个文件的差异 */
  Diff: { deviceId: string; root: string; scope: DiffScope; sessionId: string | null }
  /** 文件：浏览一个根下面的目录、看文件内容。path 是完整路径，line 给了就定位到那一行（从 1 起，对话区里的文件引用带来的） */
  Files: { deviceId: string; root: string; path?: string; line?: number }
  /** 应用设置：语言、明暗、关于 */
  Settings: undefined
  /** 开发用：WebView 吞吐测试（scripts/bench.mjs 的 webview 场景） */
  Bench: undefined
}

export type RouteName = keyof RootStackParamList
