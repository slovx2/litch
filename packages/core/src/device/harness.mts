// 对面是谁、上面有哪些 harness。
// 完整模式里 harness 的名字和状态由设备服务声明；对面只是一个普通的 Codex 服务时没有这份声明，
// 只能靠握手应答和适配器已有的 runtime/info 扩展来认，所以这里有一张已知引擎的表。
import {
  type PermissionPreset as DeclaredPreset,
  type DeviceRuntimeInfo,
  EXTENSION,
  type HarnessDeclaration,
  type HarnessFeatures,
  type HarnessInfo,
  type InitializeResponse,
  type RuntimeInfoResponse,
  type Thread,
} from '../../../protocol/src/index.mjs'
import type { HarnessAbilities, HarnessId, HarnessView, PermissionPreset } from '../model.mjs'
import { type PhraseKey, phrase } from '../phrase.mjs'
import { bilingual } from '../projection/manage.mjs'

/**
 * 一个 harness 的声明里核心自己要用的部分（界面用得着的那几样在 HarnessView.abilities 上）。
 * 没有声明的 harness 没有这份东西，调用方按“不知道”处理。
 */
export interface HarnessTerms {
  /** 它认识的我们的扩展（扩展名见协议包的 EXTENSION） */
  extensions: readonly string[]
  /** 它声明的权限预设，顺序就是界面上从上到下的顺序。null：没声明这一项，用 Codex 协议内置的三档 */
  presets: PermissionPreset[] | null
}

const listed = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/**
 * 声明的能力位 → 界面用得着的那几样。声明是对面发来的，不能只靠类型：
 * 该是“是”的地方不是明明白白的 true，一律按不会算。
 */
export function abilitiesOf(
  features: HarnessFeatures | undefined,
  id: string,
): HarnessAbilities | null {
  if (typeof features !== 'object' || features === null) return null
  return {
    fork: features.fork === true,
    // 我们回退用的是按回合标识的那一种（thread/revert），按个数的不算
    rollback: features.revert?.byTurnId === true,
    rollbackRestoresFiles: features.revert?.restoresFiles === true,
    compact: features.compact === true,
    steer: features.steer === true,
    steerImages: listed(features.steerInputTypes).includes('image'),
    images: listed(features.inputTypes).includes('image'),
    skills: listed(features.inputTypes).includes('skill'),
    // 原生 codex 也收 mention，但那是给连接器和插件用的（app://、plugin:// 这类地址），指向文件的不进给模型的话里；
    // 它自己的终端界面提到文件时也是把路径写进话里。所以它这里按带不了算
    mentions: listed(features.inputTypes).includes('mention') && id !== 'codex',
    rename: features.rename === true,
    archive: features.archive === true,
    remove: features.delete === true,
    finalOnStart: features.agentMessagePhase === 'onStart',
    turnDiff: features.turnDiff === true,
  }
}

const RISKS: readonly string[] = ['low', 'medium', 'high']

function presetOf(declared: DeclaredPreset): PermissionPreset | null {
  if (typeof declared?.id !== 'string' || !declared.id) return null
  const risk = RISKS.includes(declared.risk) ? declared.risk : 'medium'
  return {
    id: declared.id,
    risk,
    title: declared.title ? bilingual(declared.title) : null,
    note: declared.description ? bilingual(declared.description) : null,
    // 对面没说要不要确认的，高风险的照样先问一遍
    confirm: declared.requiresConfirmation ?? risk === 'high',
    switchable: declared.switchInSession !== false,
  }
}

/** 一份声明里核心自己要用的部分。什么都没声明就是 null */
export function termsOf(declaration: HarnessDeclaration): HarnessTerms | null {
  const { extensions, features, permissionPresets } = declaration
  if (extensions === undefined && features === undefined && permissionPresets === undefined) {
    return null
  }
  return {
    extensions: listed(extensions).filter((name): name is string => typeof name === 'string'),
    presets: Array.isArray(permissionPresets)
      ? permissionPresets.flatMap((preset) => presetOf(preset) ?? [])
      : null,
  }
}

const KNOWN: Record<string, { id: string; name: string; badge: string }> = {
  'claude-code': { id: 'claude', name: 'Claude Code', badge: 'CC' },
  pi: { id: 'pi', name: 'Pi', badge: 'PI' },
  dsh: { id: 'dsh', name: 'dsh', badge: 'DS' },
  // 下面四个都自报显示名和徽标，这里只是兜底，和 packages/protocol/src/harness-identity.json 一致
  opencode: { id: 'opencode', name: 'OpenCode', badge: 'OC' },
  gemini: { id: 'gemini', name: 'Gemini CLI', badge: 'GE' },
  qwen: { id: 'qwen', name: 'Qwen Code', badge: 'QW' },
  acp: { id: 'acp', name: 'ACP', badge: 'AC' },
}

/** 适配器的引擎名（claude-code）→ 界面里 harness 的标识（claude）。不认识的原样 */
export const harnessIdOf = (engine: string): string => KNOWN[engine]?.id ?? engine

/** 反过来：界面里 harness 的标识 → 适配器的引擎名（给设备发安装请求时用） */
export const engineOf = (id: string): string =>
  Object.entries(KNOWN).find(([, known]) => known.id === id)?.[0] ?? id

const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/

const firstVersion = (text: string | null | undefined): string | null =>
  text?.match(VERSION)?.[0] ?? null

/** 对面认识 runtime/info：它是适配器的一个入口 */
export function harnessFromRuntimeInfo(info: RuntimeInfoResponse): HarnessView {
  const known = KNOWN[info.engine]
  const id = known?.id ?? info.engine
  return {
    id,
    // 新一些的适配器自己报显示名和徽标；没报的照那张表
    name: info.displayName || known?.name || info.engine,
    badge: info.badge || known?.badge || id.slice(0, 2).toUpperCase(),
    state: 'ready',
    version: firstVersion(info.cliBuild),
    reason: null,
    detail: null,
    down: null,
    abilities: abilitiesOf(info.features, id),
    // 详情设置只走聚合面
    configurable: false,
  }
}

/** 对面不认识 runtime/info：按原生 codex 处理。版本号从握手应答的客户端标识里取 */
export function codexHarness(init: InitializeResponse): HarnessView {
  return {
    id: 'codex',
    name: 'Codex',
    badge: 'CX',
    state: 'ready',
    version: firstVersion(init.userAgent),
    reason: null,
    detail: null,
    down: null,
    // 原生 codex 自己的入口报不了声明：它会什么试了才知道
    abilities: null,
    configurable: false,
  }
}

/**
 * `runtime/info` 的应答是不是设备服务的：有 device 和 harnesses 的是它（完整模式），
 * 有 engine 的是适配器的单个入口。
 */
export function isDeviceRuntime(
  info: RuntimeInfoResponse | DeviceRuntimeInfo,
): info is DeviceRuntimeInfo {
  const shape = info as Partial<DeviceRuntimeInfo>
  return typeof shape.device === 'object' && shape.device !== null && Array.isArray(shape.harnesses)
}

/** 认识的几种不可用的原因各说哪一句。设备服务以后会加新的种类，不认识的按一般的“不可用”说 */
const UNAVAILABLE: Record<string, PhraseKey> = {
  // 设备进程自己看到的：它和这个运行时之间的连接
  connecting: 'harness.connecting',
  unreachable: 'harness.unreachable',
  handshakeFailed: 'harness.handshakeFailed',
  disconnected: 'harness.disconnected',
  // 适配器主进程告诉它的：运行时起没起来、为什么
  starting: 'harness.starting',
  disabled: 'harness.disabled',
  notInstalled: 'harness.notInstalled',
  versionTooLow: 'harness.versionTooLow',
  startFailed: 'harness.startFailed',
  stopped: 'harness.stopped',
}

/** 不可用的 harness 算哪一种状态：用户自己停用的单算一种，别的都是“不可用” */
const downState = (kind: string | undefined): HarnessView['state'] =>
  kind === 'disabled' ? 'disabled' : 'unavailable'

/** 设备服务声明的一个 harness → 界面看到的。名字、徽标、版本都以它报的为准 */
export function harnessFromInfo(info: HarnessInfo): HarnessView {
  const down = info.available ? null : info.unavailable
  return {
    id: info.id,
    name: info.displayName || info.id,
    badge: info.badge || info.id.slice(0, 2).toUpperCase(),
    state: info.available ? 'ready' : downState(down?.kind),
    version: info.version,
    reason: info.available ? null : phrase(UNAVAILABLE[down?.kind ?? ''] ?? 'harness.unavailable'),
    // 握手时声明过 deviceSettings 的连接，适配器主进程给的原因带着两种语言的版本：有就用它，界面按语言挑
    detail: down?.text ? bilingual(down.text) : down?.message || null,
    down: down?.kind ?? null,
    abilities: abilitiesOf(info.features, info.id),
    // 它自己声明了；设备那一级声明了没有由设备去并（device.mts）
    configurable: listed(info.extensions).includes(EXTENSION.harnessConfig),
  }
}

/**
 * 会话对象上聚合面打的 harness。单 harness 模式下没有这个字段，返回 null。
 * 聚合面给的每个会话对象（列表里的、各种应答里的、会话开始的通知里的）都带着它。
 */
export function stampedHarness(thread: Thread): HarnessId | null {
  const harness = (thread as { harness?: unknown }).harness
  return typeof harness === 'string' && harness ? harness : null
}
