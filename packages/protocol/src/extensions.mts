// 我们自己加的协议扩展。这个文件里的东西都不是 codex 原有的。
// 规则见设计文档 03 第十五节：扩展不能让没改过的官方桌面端连不上，
// 客户端在对面没有声明某项扩展时，连相关的参数都不能带。

import type { HarnessDeclaration } from './harness-capabilities.mjs'

/**
 * `runtime/info` 的应答。来源：适配器现有的扩展，结构定义在仓库根目录
 * protocol/extensions/runtime-info.json。原生 codex 不认识这个方法。
 * 结构化的声明（显示名、徽标、能力位、权限预设、支持的扩展）是 HarnessDeclaration 那几个字段；
 * `capabilities` 是早先那份字符串清单，原样留着。
 */
export interface RuntimeInfoResponse extends HarnessDeclaration {
  engine: 'claude-code' | 'pi' | 'dsh' | 'opencode' | 'gemini' | 'qwen' | 'acp'
  protocolVersion: string
  cliBuild: string
  capabilities: string[]
  releaseReady: boolean
  nodeVersion?: string
  sdkVersion?: string
}

/**
 * 拒绝时附一句说明。标准协议里命令和文件改动的“拒绝”只有一个词，带不了话，所以这是我们加的一种决定：
 * 对面在审批请求的 `availableDecisions` 里列出 `declineWithNote`，表示它收这种决定；
 * 客户端选了拒绝并且写了说明时，答这个形状，没写说明照旧答 `decline`。
 * 没声明过这项扩展的连接上，对面不会把它列出来（设计文档 03 第十五节第 3 条），客户端也就不会出这个入口。
 * 扩展名是 declineWithNote（device.mts 的 EXTENSION），定义的原文在仓库根目录
 * protocol/extensions/decline-with-note.json，决定的名字、说明的长度上限见 harness-capabilities.mts。
 */
export interface DeclineWithNoteDecision {
  declineWithNote: { note: string }
}
