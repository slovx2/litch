// OpenCode 引擎的结构化声明：`runtime/info` 里给客户端照着画界面的那部分。
// 每一位说的是“经这个适配器实际做得到”，依据写在旁边；改了对应的实现要回来改这里，
// test/declaration.test.mts 守着声明和行为一致。

import { EXTENSION } from '../../protocol/src/device.mjs'
import type {
  HarnessDeclaration,
  HarnessFeatures,
  HarnessInputType,
} from '../../protocol/src/harness-capabilities.mjs'
import { HARNESS_IDENTITY } from '../../protocol/src/harness-identity.mjs'
import { builtinPreset, PRESET } from '../../shared/src/harness-declaration.mjs'

// 输入转换在 turn.mts 的 promptInput：文字、图片（内联的和设备上的文件）、文件引用都化成 OpenCode 的消息部件；
// 技能（含 OpenCode 的斜杠命令）经 OpenCode 的 /command 执行，插话走的是普通消息，点名不了技能。
const inputTypes: HarnessInputType[] = ['text', 'image', 'localImage', 'skill', 'mention']

const features: HarnessFeatures = {
  // 会话忙着的时候再发一句，OpenCode 在当前这一步结束后把它并进正在跑的循环。
  steer: true,
  // abort 之后适配器自己收拾挂着的审批和提问（turns.mts 的 interrupt）。
  interrupt: true,
  // OpenCode 的 summarize：压缩跑成一个回合，画成上下文压缩条目。
  compact: true,
  // OpenCode 的 fork 按消息切，lastTurnId 和 beforeTurnId 都换算成切点。
  fork: true,
  // OpenCode 的 revert 退到某条用户消息之前，并且照快照把那之后改过的文件恢复原样。
  revert: { byTurnId: true, byCount: true, restoresFiles: true },
  queue: false,
  // 回合的差异是 OpenCode 按快照算的（用户消息上的 summary.diffs），不依赖 git。
  turnDiff: true,
  // 命令跑着的时候 OpenCode 一直更新输出，适配器取增量发。
  commandOutputDelta: true,
  approvals: {
    // OpenCode 的权限请求：改文件（edit）走文件改动审批，其余（bash、读项目外的文件、联网取网页、
    // 子代理、反复相同的调用等）都走命令审批，命令一栏写明是哪类权限。子代理里的请求转到父会话来问。
    kinds: ['command', 'fileChange'],
    uncovered: [],
  },
  // 模型调 OpenCode 的提问工具（question）时转来问用户，一次可以问几道（questions.mts）。
  userInput: true,
  mcpElicitation: false,
  // OpenCode 的待办（todowrite）。
  planUpdates: true,
  inputTypes,
  steerInputTypes: inputTypes.filter((type) => type !== 'skill'),
  // OpenCode 的接口没有“取消归档”：归档只是适配器这边的标记，OpenCode 自己的界面里照样看得到。
  archive: true,
  delete: true,
  rename: true,
  // 一段话是过程说明还是最终回答，要等这条助手消息结束、看它带不带工具调用才知道。
  agentMessagePhase: 'onCompleted',
}

// 档位随每条消息交给 OpenCode（turns.mts 的 presetTools），正在跑的回合用的是发出时的那一档。
// 完全访问档“来问就放行”在适配器里，换过去之后已经弹出的审批不受影响。
const switching = { switchInSession: true, switchDuringTurn: false }

export const declaration: HarnessDeclaration = {
  // 名字和徽标不在这里写：和设置里这一组的标题是同一个出处
  ...HARNESS_IDENTITY.opencode,
  // 拒绝时附的说明经 OpenCode 的权限应答交给模型，模型接着干（approvals.mts）。
  extensions: [EXTENSION.declineWithNote],
  features,
  // OpenCode 没有沙箱：三档的差别只在给不给工具、问不问。
  permissionPresets: [
    builtinPreset(
      PRESET.readOnly,
      {
        'zh-CN':
          '不给模型改文件、运行命令和开子代理的工具：读文件、搜索、联网取网页还可以。MCP 服务的工具不受限制',
        en: 'The model gets no tools to change files, run commands or start subagents: reading, searching and fetching web pages still work. MCP server tools are not restricted',
      },
      switching,
    ),
    builtinPreset(
      PRESET.workspace,
      {
        'zh-CN':
          '照 OpenCode 自己的权限设置：默认可以直接改文件、运行命令，碰到项目外的目录、反复相同的调用这类情况才来问你',
        en: "Follows OpenCode's own permission settings: by default it changes files and runs commands directly, and asks only for things like directories outside the project or repeated identical calls",
      },
      switching,
    ),
    builtinPreset(
      PRESET.fullAccess,
      {
        'zh-CN': 'OpenCode 来问的一律放行：可以改任何文件、运行任何命令、联网，没有沙箱',
        en: 'Everything OpenCode asks about is allowed: it can change any file, run any command and use the network, with no sandbox',
      },
      switching,
    ),
  ],
}
