import { declareBackgroundTasks } from '../../shared/src/background-report.mjs'
import { CODEX_PROTOCOL_VERSION } from '../../shared/src/runtime-version.mjs'
import pkg from '../package.json' with { type: 'json' }
import type { AcpAgentId } from './agent.mjs'
import { type AgentCapabilities, declarationFor } from './declaration.mjs'

// acpProtocol：ACP 的协议版本（initialize 里的 protocolVersion，是个整数），只认这一个，
// 和 protocol/versions.json 的 acpProtocol 一致（有测试核对）。ACP 不查 agent 自己的 CLI 版本：
// 能不能接只看握手时协议版本对不对、报了哪些能力。
export const versions = {
  protocol: CODEX_PROTOCOL_VERSION,
  node: '24.0.0',
  acpProtocol: 1,
  adapter: pkg.version,
} as const

/**
 * runtime/info 的应答（也是 --runtime-info 打出来的那一行）。engine 就是扮演的标识，命令行按它核对。
 * caps 是握手拿到的能力，拿不到（agent 起不来）时按什么都没有报。
 */
/** backgroundShell：这次运行打没打开注入的后台 shell，声明里的 backgroundTasks 跟着它走 */
export function runtimeInfo(
  id: AcpAgentId,
  caps: AgentCapabilities | null,
  backgroundShell = false,
) {
  return {
    engine: id,
    protocolVersion: versions.protocol,
    nodeVersion: process.versions.node,
    // agent 在 initialize 里报的版本；不报的 agent 记成 unknown
    cliBuild: caps?.agentInfo?.version || 'unknown',
    // 同一个 clientUserMessageId 再发一遍回的是同一个回合（AcpServer.start）
    capabilities: ['submission.idempotency'],
    releaseReady: false,
    ...(backgroundShell
      ? declareBackgroundTasks(declarationFor(id, caps))
      : declarationFor(id, caps)),
  }
}
