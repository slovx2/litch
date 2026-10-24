// Pi 引擎的结构化声明：`runtime/info` 里给客户端照着画界面的那部分。
// 每一位说的是“经这个适配器实际做得到”，依据写在旁边；改了对应的实现要回来改这里，
// test/declaration.test.mts 守着声明和行为一致。
import { EXTENSION } from '../../protocol/src/device.mjs'
import type {
  CapabilityText,
  HarnessDeclaration,
  HarnessFeatures,
  HarnessInputType,
} from '../../protocol/src/harness-capabilities.mjs'
import { HARNESS_IDENTITY } from '../../protocol/src/harness-identity.mjs'
import { builtinPreset, PRESET } from '../../shared/src/harness-declaration.mjs'

// 发起回合和引导用的是同一个输入转换（turn.mts 的 promptInput）；图片只收内联的（data URL）和设备上的文件。
const inputTypes: HarnessInputType[] = ['text', 'image', 'localImage', 'skill', 'mention']

// 审批由设置打开（harness.pi.approvals，默认关），运行时起来时定下、之后不变，所以声明也分两种。
// 关着：什么都不问，命令、改文件都直接执行，和有这项设置之前一样。
// 开着：主会话里跑命令走命令审批，写文件、改文件和其余要问的工具调用走文件改动审批（approvals.mts）；
// 子代理的子会话是插件另建的，挂不上钩子，里面的操作不问。
const ASKING: HarnessFeatures['approvals'] = {
  kinds: ['command', 'fileChange'],
  uncovered: ['subagents'],
}
const SILENT: HarnessFeatures['approvals'] = { kinds: [], uncovered: [] }

// 别的能力位开没开审批都一样。backgroundShell：注入的后台 shell（设置 harness.pi.backgroundShell）开着，
// 会报后台任务的集合（server.mts 的 shells）。
const features = (approvals: boolean, backgroundShell: boolean): HarnessFeatures => ({
  steer: true,
  interrupt: true,
  compact: true,
  // 要有原生会话文件才能分：一句话都没说过的新会话分不了。
  fork: true,
  // 回退只是在原生会话树上换一个位置，文件系统上的改动不动。
  revert: { byTurnId: true, byCount: true, restoresFiles: false },
  queue: true,
  turnDiff: false,
  // Pi 的工具执行过程有更新事件，命令输出一段一段地来。
  commandOutputDelta: true,
  approvals: approvals ? ASKING : SILENT,
  // 扩展要用户选择、确认、填写时转成提问；Pi 自己的模型没有提问工具。
  userInput: true,
  mcpElicitation: false,
  planUpdates: false,
  inputTypes,
  steerInputTypes: inputTypes,
  archive: true,
  delete: true,
  rename: true,
  // 一段话是过程说明还是最终回答取决于这次请求的停止原因，流式过程中还没有：
  // 开始时报的阶段值不能信，消息结束时才准。
  agentMessagePhase: 'onCompleted',
  // 后台 shell 停得掉（thread/backgroundTerminals/terminate）
  ...(backgroundShell ? { backgroundTasks: true, stopBackground: true } : {}),
})

// Pi 没有沙箱，所以一直是“完全访问”这一档，没得选；问不问跟着设置走，说明照实写。
const SILENT_PRESET: CapabilityText = {
  'zh-CN':
    '没有沙箱，也不询问：直接改文件、运行命令、访问网络。想让它动手之前先问你，到这台设备的设置里打开 Pi 的审批',
  en: "No sandbox and no asking: it changes files, runs commands and uses the network directly. To be asked first, turn on approvals for Pi in this device's settings",
}
const ASKING_PRESET: CapabilityText = {
  'zh-CN':
    '没有沙箱。主会话里运行命令、改文件、调用别的有副作用的工具之前先问你；子代理里的操作不问。询问只是让你先看一眼，不是安全边界',
  en: 'No sandbox. In the main session it asks you before running commands, changing files or calling other tools with side effects; actions inside subagents are not asked about. Asking only gives you a look first and is not a security boundary',
}

/**
 * approvals：这次运行打没打开审批（approvals.mts 的 approvalsEnabled）；backgroundShell：打没打开注入的后台 shell
 * （shared/src/background-shell.mts 的 backgroundShellEnabled）
 */
export function harnessDeclaration(
  approvals: boolean,
  backgroundShell = false,
): HarnessDeclaration {
  const extensions = approvals
    ? [
        EXTENSION.declineWithNote,
        EXTENSION.planConfirmation,
        EXTENSION.clientTools,
        EXTENSION.harnessConfig,
      ]
    : [EXTENSION.planConfirmation, EXTENSION.clientTools, EXTENSION.harnessConfig]
  return {
    // 名字和徽标不在这里写：和设置里这一组的标题是同一个出处
    ...HARNESS_IDENTITY.pi,
    // 审批请求上的“拒绝并附说明”只在打开审批时有。计划插件交了计划之后的那一问（就绪菜单）
    // 只对声明了 planConfirmation 的连接问，没声明的由客户端在回合结束后自己问（ui.mts）。
    // litch_ 命名空间的动态工具只交给声明了 clientTools 的连接（server.mts 的 call）。
    // litch/harness/* 读写 Pi 自己的配置文件（harness-config.mts），配置变化和登录进展只通知声明了它的连接。
    // 后台 shell 开着时，后台任务的集合、回合的来历只给声明了 backgroundTasks 的连接。
    extensions: backgroundShell ? [...extensions, EXTENSION.backgroundTasks] : extensions,
    features: features(approvals, backgroundShell),
    permissionPresets: [
      {
        ...builtinPreset(PRESET.fullAccess, approvals ? ASKING_PRESET : SILENT_PRESET, {
          switchInSession: false,
          switchDuringTurn: false,
        }),
        requiresConfirmation: false,
      },
    ],
  }
}
