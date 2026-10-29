// ACP 引擎的结构化声明：`runtime/info` 里给客户端照着画界面的那部分。
// 和别的引擎不同，这里的声明不是写死的：接的是哪个 agent、它在 initialize 里报了什么能力，
// 决定我们能做到什么（agent 没有 loadSession 就回放不了历史、没有 fork 就分不了叉）。
// 每一位说的是“经这个适配器、对着这个 agent 实际做得到”，test/declaration.test.mts 守着声明和行为一致。

import { EXTENSION } from '../../protocol/src/device.mjs'
import type {
  HarnessDeclaration,
  HarnessFeatures,
  HarnessInputType,
} from '../../protocol/src/harness-capabilities.mjs'
import { HARNESS_IDENTITY } from '../../protocol/src/harness-identity.mjs'
import { builtinPreset, PRESET } from '../../shared/src/harness-declaration.mjs'
import type { AcpAgentId } from './agent.mjs'

/** agent 在 initialize 里报的、我们用得上的那几项 */
export interface AgentCapabilities {
  protocolVersion: number
  /** session/load：按会话号打开并回放历史 */
  loadSession: boolean
  /** session/list */
  list: boolean
  /** session/fork（SDK 里叫 unstable_forkSession） */
  fork: boolean
  /** session/resume：接回会话、不回放 */
  resume: boolean
  /** session/close */
  close: boolean
  /** prompt 里能带图片 */
  image: boolean
  /** prompt 里能带内嵌的资源（文件内容） */
  embeddedContext: boolean
  /** agent 要求的登录方式；有的 agent 没登录时 session/new 会报要先登录 */
  authMethods: { id: string; name: string; description: string | null }[]
  agentInfo: { name: string; title: string | null; version: string | null } | null
}

const present = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== false

/** 从 initialize 的应答里取能力。缺的、形状不对的一律当没有 */
export function capabilitiesOf(response: any): AgentCapabilities {
  const caps = response?.agentCapabilities ?? {}
  const session = caps.sessionCapabilities ?? {}
  const prompt = caps.promptCapabilities ?? {}
  const info = response?.agentInfo
  return {
    protocolVersion: Number(response?.protocolVersion),
    loadSession: caps.loadSession === true,
    list: present(session.list),
    fork: present(session.fork),
    resume: present(session.resume),
    close: present(session.close),
    image: prompt.image === true,
    embeddedContext: prompt.embeddedContext === true,
    authMethods: (Array.isArray(response?.authMethods) ? response.authMethods : [])
      .filter((method: any) => typeof method?.id === 'string')
      .map((method: any) => ({
        id: method.id,
        name: String(method.name ?? method.id),
        description: typeof method.description === 'string' ? method.description : null,
      })),
    agentInfo:
      info && typeof info.name === 'string'
        ? {
            name: info.name,
            title: typeof info.title === 'string' ? info.title : null,
            version: typeof info.version === 'string' ? info.version : null,
          }
        : null,
  }
}

/**
 * 输入种类。文字总有；技能化成“/名字”交给 agent（ACP 的斜杠命令就是这样发的）；提到的文件化成资源链接
 *（resource_link，规范要求每个 agent 都收）。图片要 agent 声明了 prompt 收图片才有（turn.mts 的 promptContent）。
 */
function inputTypes(caps: AgentCapabilities | null): HarnessInputType[] {
  return ['text', 'skill', 'mention', ...(caps?.image ? (['image', 'localImage'] as const) : [])]
}

export function featuresOf(caps: AgentCapabilities | null): HarnessFeatures {
  return {
    // ACP 没有往进行中的回合里追加输入的方法：-32601。
    steer: false,
    // session/cancel；agent 迟迟不结束时由适配器收尾（AcpServer.interrupt）。
    interrupt: true,
    // ACP 没有压缩、回退、设备侧队列：-32601。
    compact: false,
    // agent 声明了 session/fork 才有；只能从会话末尾分（ACP 的分叉不带位置）。
    fork: caps?.fork ?? false,
    revert: { byTurnId: false, byCount: false, restoresFiles: false },
    queue: false,
    turnDiff: false,
    // agent 用我们的终端跑命令时输出按块转发；agent 自己一遍遍推的全量输出算出新增的那段再发（projection.mts）。
    // 只在完成时一次给全的 agent，客户端到完成才看到输出。
    commandOutputDelta: true,
    approvals: {
      // session/request_permission：改文件的工具（edit、delete、move）走文件改动审批，别的走命令审批。
      kinds: ['command', 'fileChange'],
      // 不在这个入口上打开着的会话（agent 自己起的子代理会话）来问时没人能答，一律回“取消”。
      uncovered: ['subagents'],
    },
    // ACP 稳定版里没有向用户提问的请求（elicitation 还是草案）。
    userInput: false,
    mcpElicitation: false,
    // agent 发 plan 更新就转成 turn/plan/updated；不发的 agent 就没有。
    planUpdates: true,
    inputTypes: inputTypes(caps),
    steerInputTypes: [],
    // 归档、改名只是适配器这边记的；ACP 没有删除会话（session/delete 还没进稳定版）。
    archive: true,
    delete: false,
    rename: true,
    // 一段话是过程说明还是最终回答，要看它后面还有没有工具调用：完成时才准。
    agentMessagePhase: 'onCompleted',
  }
}

const switching = { switchInSession: false, switchDuringTurn: false }

/**
 * 只有一档，照 Pi 的做法：适配器不加沙箱，什么时候来问由 agent 自己定（它自己的模式和配置），
 * 来问时转成命令审批或文件改动审批。
 */
const PRESET_TEXT = {
  'zh-CN':
    '适配器不加沙箱：agent 自己决定哪些操作先问你（看它自己的模式和配置），来问时在这里审批。询问只是让你先看一眼，不是安全边界',
  en: 'The adapter adds no sandbox: the agent decides on its own which actions to ask about (per its own modes and settings), and asks you here. Asking only gives you a look first and is not a security boundary',
}

export function declarationFor(id: AcpAgentId, caps: AgentCapabilities | null): HarnessDeclaration {
  return {
    // 名字和徽标不在这里写：和设置里这一组的标题是同一个出处
    ...HARNESS_IDENTITY[id],
    // 审批的选项是 agent 给的那几个，带不了用户写的说明：不支持 declineWithNote。
    // 动态工具经按会话挂的 MCP 桥交给 agent（ACP 要求每个 agent 都收 stdio 的 MCP 服务），
    // litch_ 命名空间的调用照 clientTools 的规矩挑执行方（client-tools.mts）。
    extensions: [EXTENSION.filePreview, EXTENSION.clientTools],
    features: featuresOf(caps),
    permissionPresets: [
      { ...builtinPreset(PRESET.fullAccess, PRESET_TEXT, switching), requiresConfirmation: false },
    ],
  }
}
