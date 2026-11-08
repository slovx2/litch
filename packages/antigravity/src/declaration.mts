import type { HarnessDeclaration } from '../../protocol/src/harness-capabilities.mjs'
import { HARNESS_IDENTITY } from '../../protocol/src/harness-identity.mjs'
import { builtinPreset, PRESET } from '../../shared/src/harness-declaration.mjs'
import { CODEX_PROTOCOL_VERSION } from '../../shared/src/runtime-version.mjs'
import { SDK_VERSION } from './install.mjs'

export const declaration: HarnessDeclaration = {
  ...HARNESS_IDENTITY.agy,
  extensions: ['harnessConfig'],
  features: {
    steer: false,
    interrupt: true,
    compact: false,
    fork: false,
    revert: { byTurnId: false, byCount: false, restoresFiles: false },
    queue: false,
    turnDiff: false,
    commandOutputDelta: false,
    approvals: { kinds: ['command', 'fileChange'], uncovered: [] },
    userInput: false,
    mcpElicitation: false,
    planUpdates: false,
    inputTypes: ['text'],
    steerInputTypes: [],
    archive: false,
    delete: false,
    rename: false,
    agentMessagePhase: 'none',
    backgroundTasks: false,
    stopAgent: false,
  },
  // 第一阶段不宣称 OS 沙箱；所有内置工具都逐次审批，子代理、网络工具和异步命令关闭。
  permissionPresets: [
    {
      ...builtinPreset(
        PRESET.fullAccess,
        {
          'zh-CN': '没有操作系统沙箱；工具每次执行前请求批准，拒绝或取消不会执行。子代理已关闭',
          en: 'No OS sandbox. Each tool requires approval; declined or cancelled calls do not run. Subagents are disabled',
        },
        { switchInSession: false, switchDuringTurn: false },
      ),
      title: { 'zh-CN': '逐次审批（无沙箱）', en: 'Ask each time (no sandbox)' },
    },
  ],
}
export const runtimeInfo = () => ({
  engine: 'agy',
  protocolVersion: CODEX_PROTOCOL_VERSION,
  nodeVersion: process.versions.node,
  cliBuild: SDK_VERSION,
  capabilities: [],
  releaseReady: false,
  ...declaration,
})
