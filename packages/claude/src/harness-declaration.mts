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
  // 回退是换一份截短的原生会话，文件系统上的改动不动。插进回合的话在原生记录里有自己的位置，
  // 回退、分叉都能切在它之前（steer-cut.mts）
  revert: { byTurnId: true, byCount: true, restoresFiles: false, byItemId: true },
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
  // 插话带的图片和回合开头一样发成内容块，CLI 回合中途交给模型时照样带上
  steerInputTypes: ['text', 'image', 'localImage', 'skill', 'mention'],
  archive: true,
  delete: true,
  rename: true,
  // 一段话是过程说明还是最终回答，要等它后面有没有工具调用才知道：开始时不带阶段值。
  agentMessagePhase: 'onCompleted',
  // 回合结束后还在跑的后台命令、Monitor、后台子代理从 CLI 的 background_tasks_changed 攒成集合（background-tasks.mts）
  backgroundTasks: true,
  // 子代理的子线程上的 turn/interrupt 只停这一个子代理（CLI 的 stop_task），父会话的回合照常
  stopAgent: true,
  // 后台命令、监视经 CLI 的 stop_task 停（thread/backgroundTerminals/terminate）
  stopBackground: true,
  // 持续目标照上游做（goal-controller.mts）：目标存在入口自己的库里，空闲时自动续跑，
  // 模型经 codex_harness_adapter_goal 的三个工具读目标、报完成或受阻，用量按原生消息累计
  goals: true,
  // 临时分叉（ephemeral）是一份带着历史的 CLI 会话，照常跑回合；卸载时连 CLI 写下的记录一起删（server.mts 的 scheduleEphemeralUnload）
  ephemeralFork: true,
}

// 权限档随回合开始时的会话设置定下来：两个回合之间可以换，回合进行中改的要到下一个回合才起作用。
const switching = { switchInSession: true, switchDuringTurn: false }

// Windows 原生宿主没有系统沙箱：只读和项目内两档跑不了命令（command-sandbox.mts 当场拒绝），说明照实写
const windows = process.platform === 'win32'

const permissionPresets: PermissionPreset[] = [
  builtinPreset(
    PRESET.readOnly,
    windows
      ? {
          'zh-CN':
            '只能看：可以读文件、搜索；不能改文件，也不能运行命令（Windows 上没有沙箱，要跑命令请选完全访问，或在 WSL2 里用）',
          en: 'Look only: can read files and search. Cannot change files or run commands (Windows has no sandbox; choose full access to run commands, or use WSL2)',
        }
      : {
          'zh-CN': '只能看：可以读文件、搜索，在只读且断网的沙箱里运行命令；不能改文件，也不能联网',
          en: 'Look only: can read files, search, and run commands in a read-only sandbox with no network. Cannot change files or go online',
        },
    switching,
  ),
  builtinPreset(
    PRESET.workspace,
    windows
      ? {
          'zh-CN':
            '可以改项目里的文件，动手之前先问你；不能运行命令（Windows 上没有沙箱，要跑命令请选完全访问，或在 WSL2 里用）',
          en: 'Can change files in the project, asking you first. Cannot run commands (Windows has no sandbox; choose full access to run commands, or use WSL2)',
        }
      : {
          'zh-CN':
            '可以改项目里的文件、运行命令，动手之前先问你；命令在只能写项目、断网的沙箱里运行',
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
    // litch_ 命名空间的动态工具只交给声明了 clientTools 的连接（server.mts 的 clientToolExecutor）；
    // harness 详情设置（litch/harness/*）读写 Claude Code 自己的配置与账号（harness-config.mts）；
    // 后台任务的集合、回合的来历只给声明了 backgroundTasks 的连接（server.mts 的 withBackground）
    extensions: [
      EXTENSION.declineWithNote,
      EXTENSION.planConfirmation,
      EXTENSION.clientTools,
      EXTENSION.harnessConfig,
      EXTENSION.backgroundTasks,
    ],
    features,
    permissionPresets,
  }
}
