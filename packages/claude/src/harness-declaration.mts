// Claude Code 引擎的结构化声明：`runtime/info` 里给客户端照着画界面的那部分。
// 每一位说的是“经这个适配器实际做得到”，依据写在旁边；改了对应的实现要回来改这里，
// test/harness-declaration.test.mts 和 test/decline-with-note.test.mts 守着声明和行为一致。
import { EXTENSION } from '../../protocol/src/device.mjs'
import type {
  HarnessDeclaration,
  HarnessFeatures,
  PermissionPreset,
} from '../../protocol/src/harness-capabilities.mjs'
import { HARNESS_IDENTITY } from '../../protocol/src/harness-identity.mjs'
import { builtinPreset, PRESET } from '../../shared/src/harness-declaration.mjs'
import type { RuntimeBackendType } from './runtime-config.mjs'

const features: HarnessFeatures = {
  steer: true,
  interrupt: true,
  compact: true,
  fork: true,
  // 回退是换一份截短的原生会话，文件系统上的改动不动。
  revert: { byTurnId: true, byCount: true, restoresFiles: false },
  queue: true,
  // 每次工具调用结束后拿 git 算一遍，工作目录不是 git 仓库时没有。
  turnDiff: true,
  // SDK 不给工具输出的增量：命令结束时一次送出，后台命令也是结束时才送。
  commandOutputDelta: false,
  approvals: {
    // 命令走命令审批；改文件和其余要问的自带工具走文件改动审批；模型申请追加权限走权限审批。
    // MCP 工具调用的审批不在这三种里：照原生 codex 的做法是一条征询（下面的 mcpElicitation）。
    kinds: ['command', 'fileChange', 'permissions'],
    // 子代理的工具调用和主会话走同一个权限回调，审批请求发到父会话上。
    uncovered: [],
  },
  userInput: true,
  mcpElicitation: true,
  // 待办工具（TodoWrite）转成 turn/plan/updated。
  planUpdates: true,
  inputTypes: ['text', 'image', 'localImage', 'skill', 'mention'],
  // 引导只把文字交给模型：图片到不了，只剩一个占位的词。
  steerInputTypes: ['text', 'skill', 'mention'],
  archive: true,
  delete: true,
  rename: true,
  // 一段话是过程说明还是最终回答，要等它后面有没有工具调用才知道：开始时不带阶段值。
  agentMessagePhase: 'onCompleted',
}

// 权限档随回合开始时的会话设置定下来：两个回合之间可以换，回合进行中改的要到下一个回合才起作用。
const switching = { switchInSession: true, switchDuringTurn: false }

const permissionPresets: PermissionPreset[] = [
  builtinPreset(
    PRESET.readOnly,
    {
      'zh-CN': '只能看：可以读文件、搜索，在只读且断网的沙箱里运行命令；不能改文件，也不能联网',
      en: 'Look only: can read files, search, and run commands in a read-only sandbox with no network. Cannot change files or go online',
    },
    switching,
  ),
  builtinPreset(
    PRESET.workspace,
    {
      'zh-CN': '可以改项目里的文件、运行命令，动手之前先问你；命令在只能写项目、断网的沙箱里运行',
      en: 'Can change files in the project and run commands, asking you first. Commands run in a sandbox that can only write to the project and has no network',
    },
    switching,
  ),
  builtinPreset(
    PRESET.fullAccess,
    {
      'zh-CN': '不再问你：可以改任何文件、运行任何命令、访问网络，没有沙箱。向你提问和计划确认照常',
      en: 'No more asking: can change any file, run any command and use the network, with no sandbox. Questions and plan confirmations still come to you',
    },
    switching,
  ),
]

/**
 * 能力位和权限预设说的是原生运行方式（进程内的 Claude Agent SDK）；测试用的模拟运行时照它的样子做。
 * 实验性的几种运行方式（agent-http、agentapi、claude-p）只有文字输出，没有工具和审批事件，
 * 也没有逐项核对过：只报名字和徽标，客户端对它们退回“试了才知道”。
 */
export function harnessDeclaration(runtime: RuntimeBackendType): HarnessDeclaration {
  // 名字和徽标不在这里写：和设置里这一组的标题是同一个出处
  const identity = HARNESS_IDENTITY['claude-code']
  if (runtime !== 'agent-sdk-sidecar' && runtime !== 'mock') return identity
  return {
    ...identity,
    // 计划确认（ExitPlanMode）只对声明了 planConfirmation 的连接在回合里问（native-runtime.mts）；
    // litch_ 命名空间的动态工具只交给声明了 clientTools 的连接（server.mts 的 clientToolExecutor）
    extensions: [EXTENSION.declineWithNote, EXTENSION.planConfirmation, EXTENSION.clientTools],
    features,
    permissionPresets,
  }
}
