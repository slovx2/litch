// dsh 引擎的结构化声明：`runtime/info` 里给客户端照着画界面的那部分。
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

// 发起回合和插话用的是同一个输入转换（turn.mts 的 promptContent），dsh 的插话也收图片。
// 图片只收内联的（data URL）和设备上的文件；技能和文件引用都化成文字交给 dsh。
// 技能化成单独一行的“/名字”：dsh 在用户的话里见到这样一个词、又确有这项用户可以点名的技能，就把它的正文
// 交给模型，在话的哪个位置、带不带图片、是不是插话都一样（test/skills.test.mts）。有哪些技能用 skills/list 问。
const inputTypes: HarnessInputType[] = ['text', 'image', 'localImage', 'skill', 'mention']

const features: HarnessFeatures = {
  // 插话在当前这一步（一次模型请求和它发起的工具调用）结束后并入同一回合，不打断正在进行的输出。
  steer: true,
  interrupt: true,
  // 下面这几项适配器还没接：调用会得到“方法不存在”（-32601）。
  compact: false,
  fork: false,
  revert: { byTurnId: false, byCount: false, restoresFiles: false },
  queue: false,
  turnDiff: false,
  // 命令的输出随落盘的工具结果一次到达。
  commandOutputDelta: false,
  approvals: {
    // dsh 只在模型申请放宽沙箱时来问：申请的是改文件的工具走文件改动审批，其余走命令审批。
    kinds: ['command', 'fileChange'],
    // 子代理的会话被 dsh 固定成“从不询问”：它申请放宽时直接被拒绝，不会来问用户。
    uncovered: ['subagents'],
  },
  // 模型调 dsh 的提问工具（ask_user_question）时转来问用户（questions.mts，test/questions.test.mts）。
  // 计划模式没有接：它只能由 dsh 的 /plan 命令打开，适配器不发这条命令，计划评审就不会来。
  userInput: true,
  mcpElicitation: false,
  planUpdates: false,
  inputTypes,
  steerInputTypes: inputTypes,
  // 归档只是适配器这边的标记；dsh 的远程接口没有删除会话。
  archive: true,
  delete: false,
  rename: true,
  // 一段话是过程说明还是最终回答，要等这一步落盘、看它带不带工具调用才知道：
  // 流式开始时一律先报成最终回答，结束时才准。
  agentMessagePhase: 'onCompleted',
}

// 换档是给 dsh 发一条 /permission 命令：回合进行中也立即执行，同一回合里后面的工具调用就按新的一档判定
// （已经开始执行的那一次调用、已经弹出的审批不受影响）。
const switching = { switchInSession: true, switchDuringTurn: true }

export const declaration: HarnessDeclaration = {
  // 名字和徽标不在这里写：和设置里这一组的标题是同一个出处
  ...HARNESS_IDENTITY.dsh,
  // dsh 的审批裁决只有“允许这一次”和“拒绝”，拒绝的理由是固定的一句话，带不了用户写的说明：
  // 所以不支持 declineWithNote，审批请求里也不列它。
  // litch_ 命名空间的动态工具只交给声明了 clientTools 的连接（server.mts 的 clientToolCall），
  // 工具经 dsh 里的插件交给模型（client-tools.mts）。
  extensions: [EXTENSION.clientTools],
  features,
  // dsh 的沙箱只管写文件：三档都能读任何文件，也都不限制联网。
  permissionPresets: [
    builtinPreset(
      PRESET.readOnly,
      {
        'zh-CN':
          '不能改文件：读文件、搜索、联网、运行不写文件的命令都可以。要写文件时模型得先申请，那时才来问你',
        en: 'Cannot change files: reading, searching, network access and commands that write nothing are all allowed. To write, the model has to request it first, and only then are you asked',
      },
      switching,
    ),
    builtinPreset(
      PRESET.workspace,
      {
        'zh-CN':
          '可以直接改项目和临时目录里的文件、运行命令、联网，不会先问你。要写到别的地方时模型得先申请，那时才来问你',
        en: 'Can change files in the project and temp directories, run commands and use the network without asking. To write anywhere else, the model has to request it first, and only then are you asked',
      },
      switching,
    ),
    builtinPreset(
      PRESET.fullAccess,
      {
        'zh-CN': '不再问你：可以改任何文件、运行任何命令、联网，没有沙箱',
        en: 'No more asking: can change any file, run any command and use the network, with no sandbox',
      },
      switching,
    ),
  ],
}
