// 侧栏的本机整理：跨设备的“本机分组”和全局置顶的本机先后。只存在这台客户端上（桌面一份、手机一份），
// 不同步、不上传设备；设备上的置顶和设备分组照旧由设备保存，这里只记引用和顺序。
// 本文件是文件格式、校验和整理动作，都是纯函数；谁来存、怎么存由外壳注入（host.mts 的 OrganizerStore）。

/** 一个会话的引用：哪台设备（客户端的连接登记键）上的哪个会话 */
export interface SessionRef {
  deviceId: string
  sessionId: string
}

/** 置顶区里的一项：置顶的会话，或者置顶的项目（工作区） */
export type PinRef =
  | { kind: 'session'; deviceId: string; sessionId: string }
  | { kind: 'workspace'; deviceId: string; workspaceId: string }

/** 一个本机分组。members 的先后就是组里的先后 */
export interface LocalGroup {
  id: string
  name: string
  members: SessionRef[]
}

export const ORGANIZER_VERSION = 1
/** 组名最长多少个字符 */
export const GROUP_NAME_MAX = 80

/** 文件的样子。groups 的先后就是组头的先后 */
export interface OrganizerFile {
  version: typeof ORGANIZER_VERSION
  /** 每写一次加一：窗口拿着旧的先后来改时据此拒绝，免得互相覆盖 */
  revision: number
  groups: LocalGroup[]
  pinOrder: PinRef[]
  /** 收起了的区域：置顶区（PINS_FOLD）、本机分组区（GROUPS_FOLD）、各个本机组的标识 */
  folds: Record<string, boolean>
}

export const PINS_FOLD = ':pins'
export const GROUPS_FOLD = ':groups'

/** 读文件的结果。坏了、版本更高的都不能当成空的写回去 */
export type OrganizerLoad =
  | { kind: 'ok'; file: OrganizerFile }
  | { kind: 'empty' }
  | { kind: 'corrupt' }
  | { kind: 'newer'; version: number }

export const emptyOrganizer = (): OrganizerFile => ({
  version: ORGANIZER_VERSION,
  revision: 0,
  groups: [],
  pinOrder: [],
  folds: {},
})

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const refKey = (ref: SessionRef): string => JSON.stringify([ref.deviceId, ref.sessionId])
export const pinKey = (ref: PinRef): string =>
  JSON.stringify([ref.kind, ref.deviceId, ref.kind === 'session' ? ref.sessionId : ref.workspaceId])
export const sameRef = (a: SessionRef, b: SessionRef): boolean =>
  a.deviceId === b.deviceId && a.sessionId === b.sessionId

function checkRef(value: unknown): SessionRef | null {
  if (!isRecord(value) || !isText(value.deviceId) || !isText(value.sessionId)) return null
  return { deviceId: value.deviceId, sessionId: value.sessionId }
}

function checkPin(value: unknown): PinRef | null {
  if (!isRecord(value) || !isText(value.deviceId)) return null
  if (value.kind === 'session' && isText(value.sessionId))
    return { kind: 'session', deviceId: value.deviceId, sessionId: value.sessionId }
  if (value.kind === 'workspace' && isText(value.workspaceId))
    return { kind: 'workspace', deviceId: value.deviceId, workspaceId: value.workspaceId }
  return null
}

/** 组名：去掉首尾空白，不能为空、不能太长。不合格是 null */
export function groupName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name && name.length <= GROUP_NAME_MAX ? name : null
}

/**
 * 认文件。没有是 empty；版本比这一版高是 newer；形状不对、引用缺字段、有重复（组标识、成员、置顶项）都是 corrupt
 */
export function parseOrganizer(raw: unknown): OrganizerLoad {
  if (raw === null || raw === undefined) return { kind: 'empty' }
  if (!isRecord(raw)) return { kind: 'corrupt' }
  const version = raw.version
  if (typeof version !== 'number' || !Number.isInteger(version)) return { kind: 'corrupt' }
  if (version > ORGANIZER_VERSION) return { kind: 'newer', version }
  if (version !== ORGANIZER_VERSION) return { kind: 'corrupt' }
  const revision = raw.revision
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0)
    return { kind: 'corrupt' }
  if (!Array.isArray(raw.groups) || !Array.isArray(raw.pinOrder) || !isRecord(raw.folds))
    return { kind: 'corrupt' }
  const groups: LocalGroup[] = []
  const groupIds = new Set<string>()
  const members = new Set<string>()
  for (const entry of raw.groups) {
    if (!isRecord(entry) || !isText(entry.id) || groupIds.has(entry.id)) return { kind: 'corrupt' }
    const name = groupName(entry.name)
    if (name === null || name !== entry.name || !Array.isArray(entry.members))
      return { kind: 'corrupt' }
    groupIds.add(entry.id)
    const refs: SessionRef[] = []
    for (const value of entry.members) {
      const ref = checkRef(value)
      if (!ref || members.has(refKey(ref))) return { kind: 'corrupt' }
      members.add(refKey(ref))
      refs.push(ref)
    }
    groups.push({ id: entry.id, name, members: refs })
  }
  const pinOrder: PinRef[] = []
  const pins = new Set<string>()
  for (const value of raw.pinOrder) {
    const ref = checkPin(value)
    if (!ref || pins.has(pinKey(ref))) return { kind: 'corrupt' }
    pins.add(pinKey(ref))
    pinOrder.push(ref)
  }
  const folds: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(raw.folds)) {
    if (typeof value !== 'boolean') return { kind: 'corrupt' }
    if (value) folds[key] = true
  }
  return { kind: 'ok', file: { version: ORGANIZER_VERSION, revision, groups, pinOrder, folds } }
}
