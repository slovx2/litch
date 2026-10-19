// 原生 codex 作为聚合面上的一个 harness。
// 它是用户自己装的 codex 起的 app-server，只说标准的 Codex 协议：握手时不认识我们的扩展键，
// 没有 `runtime/info`，不认识的方法一律回“无效请求”。和适配器的运行时不一样的地方都在这个文件里：
//   - 握手：我们的扩展键不带过去；
//   - 声明：它自己报不了，由这里替它整理（显示名、徽标、版本、能力位、权限预设）；
//   - 权限预设到底层设置的映射：留在这里，客户端只管选预设；
//   - “不支持”：把它对不认识的方法回的“无效请求”换成聚合面一致的“不支持”；
//   - 审批：它的协议里有决定列表的用它原生的，没有的补上固定的几种。
// 下面每一项后面写着依据。“实测”指 codex 0.160.0 在隔离的数据目录里对着回环地址上的假模型跑出来的结果；
// “源码”指上游 openai/codex 在 rust-v0.157.1（仓库里协议类型固定的那一版）的代码。

import { CLIENT_TOOLS_CAPABILITY } from '../../protocol/src/client-tools.mjs'
import {
  DEVICE_ERROR_CODE,
  type DeviceErrorData,
  EXTENSION,
  EXTENSIONS_CAPABILITY,
} from '../../protocol/src/device.mjs'
import type {
  HarnessDeclaration,
  HarnessFeatures,
  ListedApprovalDecision,
  PermissionPreset,
} from '../../protocol/src/harness-capabilities.mjs'
import { HARNESS_IDENTITY } from '../../protocol/src/harness-identity.mjs'
import { builtinPreset, PRESET } from '../../shared/src/harness-declaration.mjs'
import { CodexHarnessConfig } from './codex-harness-config.mjs'
import {
  ADAPTER_DIALECT,
  type Ask,
  foldToolInstructions,
  type UpstreamDialect,
  withoutOptOut,
} from './dialect.mjs'
import { isObject } from './wire.mjs'

/** 声明里报的引擎名 */
export const NATIVE_CODEX_ENGINE = 'codex'

/**
 * 能力位。说的是“这一版起的原生 codex 经聚合面做得到什么”，下限版本（Go 层的 minimumCodexVersion）以上都成立。
 */
function codexFeatures(): HarnessFeatures {
  return {
    // turn/steer、turn/interrupt：协议原有的方法，实测都认
    steer: true,
    interrupt: true,
    // thread/compact/start：实测
    compact: true,
    // thread/fork 带 lastTurnId：实测；beforeTurnId 在协议类型里也有
    fork: true,
    revert: {
      // thread/revert 带 beforeTurnId：实测
      byTurnId: true,
      // thread/rollback 上游已经删了：实测回的是“不认识的方法”
      byCount: false,
      // 只退历史。上游的说明写明不恢复本地的文件改动
      restoresFiles: false,
    },
    // thread/queue/*：实测（要握手时声明 experimentalApi）
    queue: true,
    // turn/diff/updated、item/commandExecution/outputDelta：协议原有的通知（源码）
    turnDiff: true,
    commandOutputDelta: true,
    approvals: {
      // 命令审批实测往返过；文件改动和追加权限是协议里的另外两种服务端请求（源码）
      kinds: ['command', 'fileChange', 'permissions'],
      // 子代理的会话一建出来就挂到这个 app-server 上所有握过手的连接上，它们的审批也会来问（源码）
      uncovered: [],
    },
    // request_user_input 在它给模型的工具表里：实测
    userInput: true,
    // mcpServer/elicitation/request 是协议里的服务端请求（源码）
    mcpElicitation: true,
    // update_plan 工具默认是关的，用户在自己的 codex 配置里打开了才会有 turn/plan/updated（实测工具表里没有它；
    // 源码在 0.157.1 和 0.162.0-alpha.20 都是默认关）。设备进程不读用户的配置，按默认报
    planUpdates: false,
    // 协议的 UserInput 还有 audio、localAudio 两种，聚合面的声明里没有这两个名字
    inputTypes: ['text', 'image', 'localImage', 'skill', 'mention'],
    steerInputTypes: ['text', 'image', 'localImage', 'skill', 'mention'],
    // thread/archive、thread/unarchive、thread/delete、thread/name/set：实测
    archive: true,
    delete: true,
    rename: true,
    // 模型在条目一开始给的阶段值，item/started 里就带着：用分阶段回话的假模型实测
    agentMessagePhase: 'onStart',
  }
}

/** 换档对下一个回合起作用，正在进行的回合不变：实测（thread/settings/update 之后的回合才用新的） */
const SWITCHING = { switchInSession: true, switchDuringTurn: false }

/**
 * 权限预设：codex 自己的三个内置权限档（`permissionProfile/list` 给的就是这三个标识，实测）。
 * 说明照它们配上各自的审批策略之后的实际效果写（见下面的 PRESET_APPROVAL）。
 * 用户在 codex 配置里自己定义的权限档不在这里：它们的风险等级和该不该二次确认设备进程判断不了。
 */
function builtinPresets(): PermissionPreset[] {
  return [
    builtinPreset(
      PRESET.readOnly,
      {
        'zh-CN': '只能读文件。要改文件、跑有副作用的命令或者联网时先来问。',
        en: 'Can read files. Asks before editing files, running commands with side effects, or using the network.',
      },
      SWITCHING,
    ),
    builtinPreset(
      PRESET.workspace,
      {
        'zh-CN': '可以在工作目录里读写文件、跑命令。要动工作目录以外的地方或者联网时先来问。',
        en: 'Can read and edit files and run commands inside the working directory. Asks before touching anything outside it or using the network.',
      },
      SWITCHING,
    ),
    builtinPreset(
      PRESET.fullAccess,
      {
        'zh-CN': '不设沙箱，也不来问：可以改这台设备上的任何文件，可以联网。',
        en: 'No sandbox and no questions asked: can change any file on this device and use the network.',
      },
      SWITCHING,
    ),
  ]
}

/**
 * 预设到底层设置的映射里，权限档以外的那一半：选一个内置档时配哪种审批策略。
 * 只选权限档不会带动审批策略（实测：选了 `:danger-full-access`，审批策略还是原来的 on-request），
 * 所以要一起给。配法照上游自己的三个内置预设（源码 codex-rs/utils/approval-presets）：
 * 只读和工作区是 on-request，完全访问是 never。
 */
const PRESET_APPROVAL: Record<string, string> = {
  [PRESET.readOnly]: 'on-request',
  [PRESET.workspace]: 'on-request',
  [PRESET.fullAccess]: 'never',
}

/** 这几个方法的 `permissions` 参数是权限档的标识（协议类型里都是这个名字，实测都收） */
const PRESET_METHODS = new Set([
  'thread/start',
  'thread/resume',
  'thread/fork',
  'turn/start',
  'thread/settings/update',
])

/**
 * 文件改动的审批在标准协议里不带决定列表，可选的决定是固定的这四种（协议类型 FileChangeApprovalDecision）。
 * 命令审批不用补：它自己带 `availableDecisions`（实测每一条都带，包括按规则放行那种带参数的决定）。
 * 追加权限的审批答的是“给哪些权限、管多久”，不是从几个决定里选一个，没有列表可补。
 */
export const FILE_CHANGE_DECISIONS: readonly ListedApprovalDecision[] = [
  'accept',
  'acceptForSession',
  'decline',
  'cancel',
]

/**
 * 握手应答的 userAgent 是“<客户端名>/<codex 版本> (<系统>; <架构>) …”（实测）。
 * 客户端名是客户端自己报的，里面万一有像版本号的东西不能当成 codex 的版本，所以认斜杠后面、括号前面的那一段。
 */
export function codexVersion(userAgent: unknown): string | null {
  if (typeof userAgent !== 'string') return null
  return userAgent.match(/\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?= \(|$)/)?.[1] ?? null
}

/** 内置的三档里，这个 codex 现在不许选的去掉（比如被管理员的要求禁了）。问不到就三档都报 */
async function allowedPresets(ask: Ask): Promise<PermissionPreset[]> {
  const presets = builtinPresets()
  try {
    const result = await ask('permissionProfile/list', {})
    if (!isObject(result) || !Array.isArray(result.data)) return presets
    const refused = new Set(
      result.data
        .filter((item) => isObject(item) && item.allowed === false)
        .map((item) => (item as { id?: unknown }).id),
    )
    return presets.filter((preset) => !refused.has(preset.id))
  } catch {
    // 客户端握手时没声明 experimentalApi 的连接上这个方法用不了，或者这一版没有它
    return presets
  }
}

export const NATIVE_CODEX_DIALECT: UpstreamDialect = {
  /**
   * 我们的扩展键它不认识，不带过去（没声明认识的对面，线上只有标准协议的内容）；
   * 退订名单也不带，和适配器的运行时一样由聚合面自己拦；客户端工具的声明（litchClientTools）也是我们的键，
   * 由设备进程自己看（client-tools.mts）
   */
  initializeParams(given) {
    const plain = withoutOptOut(given)
    if (!isObject(plain) || !isObject(plain.capabilities)) return plain
    const {
      [EXTENSIONS_CAPABILITY]: _ours,
      [CLIENT_TOOLS_CAPABILITY]: _tools,
      ...capabilities
    } = plain.capabilities
    return { ...plain, capabilities }
  },

  // 它把动态工具的调用发给所有订阅连接（实测），litch_ 命名空间的由设备进程挑执行方
  clientToolsByDevice: true,

  // 它不认识 litch/harness/*：设备进程翻译成它自己的 config/*、account/*、mcpServer/* 等
  harnessConfig: (context) => new CodexHarnessConfig(context),

  async describe(initialized, ask) {
    const version = isObject(initialized) ? codexVersion(initialized.userAgent) : null
    const declaration: Required<HarnessDeclaration> = {
      ...HARNESS_IDENTITY.codex,
      // 它不认识我们的任何扩展。“拒绝时附说明”也没有：它的拒绝带不了话。
      // 客户端工具是设备进程替它做的（client-tools.mts），经聚合面连到它时成立；
      // harness 详情设置也是设备进程替它翻译的（codex-harness-config.mts）
      extensions: [EXTENSION.clientTools, EXTENSION.harnessConfig],
      features: codexFeatures(),
      permissionPresets: await allowedPresets(ask),
    }
    return {
      engine: NATIVE_CODEX_ENGINE,
      ...(version ? { cliBuild: version } : {}),
      ...declaration,
    }
  },

  /**
   * 动态工具的命名空间带的规则（instructions）它不认，摘下来并进开发者指令（dialect.mts 的 foldToolInstructions）；
   * 选了内置的权限档、又没有另外指定审批策略的：把这一档配套的审批策略带上
   */
  outgoing(method, given) {
    const folded = foldToolInstructions(method, given)
    const params = folded ?? given
    if (!PRESET_METHODS.has(method) || params.approvalPolicy != null) return folded
    const approvalPolicy =
      typeof params.permissions === 'string' ? PRESET_APPROVAL[params.permissions] : undefined
    return approvalPolicy === undefined ? folded : { ...params, approvalPolicy }
  },

  /**
   * 它对不认识的方法回的是 -32600“Invalid request: unknown variant `<方法名>`, expected one of …”（实测），
   * 和参数写错了是同一个错误码。只有原文里点名的正是这次请求的方法名，才说明是“这个 codex 没有这个方法”，
   * 换成聚合面一致的“不支持”（标准的“方法不存在”-32601，data 里带原因、方法和 harness），
   * 客户端据此记住这个 harness 不会这件事并降级。
   * 别的一律原样带回去，不能盖掉真的错误：参数类型不对（invalid type）、参数里的枚举值不认识
   * （也是 unknown variant，但点名的是那个值）、会话没装载、实验性方法没声明 experimentalApi、
   * 会话正被别的 codex 进程写着（already has an active writer）……这些都是要让人看到原话的。
   */
  rejection(harness, method, error) {
    if (error.code !== -32600 || typeof error.message !== 'string') return null
    if (!error.message.includes(`unknown variant \`${method}\``)) return null
    const data: DeviceErrorData = { litch: 'unsupported', method, harness }
    return {
      code: DEVICE_ERROR_CODE.unsupported,
      message: `${harness} 不支持 ${method}：这台设备上装的 codex 不认识这个方法`,
      data,
    }
  },

  /**
   * 文件改动的审批：给声明过 declineWithNote 的连接补上决定列表（这个字段是那项扩展定义的，
   * 没声明的连接上线上内容和标准协议逐字段相同）。列表里没有 declineWithNote：它收不了说明。
   */
  serverRequest(method, params, declares) {
    if (method !== 'item/fileChange/requestApproval') return false
    if (params.availableDecisions !== undefined || !declares(EXTENSION.declineWithNote))
      return false
    params.availableDecisions = [...FILE_CHANGE_DECISIONS]
    return true
  },
}

/** 这个上游说哪种话。native：适配器主进程（或者启动配置）说它是原生的 codex */
export const dialectFor = (native: boolean | undefined): UpstreamDialect =>
  native ? NATIVE_CODEX_DIALECT : ADAPTER_DIALECT
