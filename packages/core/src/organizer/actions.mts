// 本机整理的动作：一次只改一处（建组、改名、删组、排组、加入移出、组内排序、置顶先后、收起），
// 标题排序和成员移动互不覆盖。纯函数：给旧文件和动作，回新文件；不合理的动作抛 OrganizerRefusal。
import {
  checkMember,
  groupName,
  type LocalGroup,
  type MemberRef,
  type OrganizerFile,
  type PinRef,
  pinKey,
  refKey,
  sameRef,
} from './file.mjs'

export type OrganizerAction =
  /** 新建一个组（排在最后）；members 一起放进去（从别的组挪过来） */
  | { type: 'group.create'; name: string; members?: MemberRef[] }
  | { type: 'group.rename'; groupId: string; name: string }
  /** 删组只删引用，不动设备上的会话 */
  | { type: 'group.delete'; groupId: string }
  /** 把组挪到第 to 个（按挪走之后的位置数） */
  | { type: 'group.move'; groupId: string; to: number }
  /** 放进一个组；已在别的组里就挪过来（一个成员最多在一个本机组里）。to 不给是排到最后 */
  | { type: 'member.add'; groupId: string; member: MemberRef; to?: number }
  | { type: 'member.remove'; member: MemberRef }
  /** 组内挪到第 to 个 */
  | { type: 'member.move'; member: MemberRef; to: number }
  /**
   * 换掉置顶的先后。base 是界面算这份先后时手上的版本号：中间别的窗口写过就拒绝，免得互相覆盖
   */
  | { type: 'pins.order'; order: PinRef[]; base: number }
  /** 这一端取消置顶成功了：清掉它的位置，再置顶时当新的接在最后 */
  | { type: 'pins.drop'; ref: PinRef }
  | { type: 'fold'; key: string; closed: boolean }

export type OrganizerRefusalReason = 'invalid' | 'notFound' | 'conflict'

export class OrganizerRefusal extends Error {
  readonly reason: OrganizerRefusalReason
  constructor(reason: OrganizerRefusalReason, message: string) {
    super(message)
    this.reason = reason
  }
}

const refuse = (reason: OrganizerRefusalReason, message: string): never => {
  throw new OrganizerRefusal(reason, message)
}

const clamp = (to: number, length: number): number =>
  Number.isInteger(to) ? Math.min(Math.max(0, to), length) : refuse('invalid', '位置无效')

const moveTo = <T,>(list: readonly T[], from: number, to: number): T[] => {
  const rest = list.filter((_, index) => index !== from)
  const at = clamp(to, rest.length)
  return [...rest.slice(0, at), list[from] as T, ...rest.slice(at)]
}

const groupOf = (file: OrganizerFile, groupId: string): LocalGroup =>
  file.groups.find((group) => group.id === groupId) ?? refuse('notFound', '本地分组不存在')

const checkedRef = (ref: MemberRef): MemberRef =>
  checkMember(ref) ?? refuse('invalid', '成员引用无效')

const without = (groups: readonly LocalGroup[], refs: readonly MemberRef[]): LocalGroup[] => {
  const gone = new Set(refs.map(refKey))
  return groups.map((group) =>
    group.members.some((member) => gone.has(refKey(member)))
      ? { ...group, members: group.members.filter((member) => !gone.has(refKey(member))) }
      : group,
  )
}

const named = (name: string): string =>
  groupName(name) ?? refuse('invalid', '组名不能为空，也不能超过 80 个字')

/**
 * 做一个动作。id 是新建组时用的标识（外面生成、保证不和已有的撞）。
 * 返回的文件 revision 已经加一；什么都没变时原样返回（不写盘）
 */
export function applyOrganizer(
  file: OrganizerFile,
  action: OrganizerAction,
  id: () => string,
): OrganizerFile {
  const next = (patch: Partial<OrganizerFile>): OrganizerFile => ({
    ...file,
    ...patch,
    revision: file.revision + 1,
  })
  switch (action.type) {
    case 'group.create': {
      const members = (action.members ?? []).map(checkedRef)
      const unique = members.filter(
        (ref, index) => members.findIndex((other) => sameRef(other, ref)) === index,
      )
      const group: LocalGroup = { id: id(), name: named(action.name), members: unique }
      return next({ groups: [...without(file.groups, unique), group] })
    }
    case 'group.rename': {
      const group = groupOf(file, action.groupId)
      const name = named(action.name)
      if (group.name === name) return file
      return next({
        groups: file.groups.map((entry) => (entry.id === group.id ? { ...entry, name } : entry)),
      })
    }
    case 'group.delete': {
      groupOf(file, action.groupId)
      const { [action.groupId]: _gone, ...folds } = file.folds
      return next({ groups: file.groups.filter((entry) => entry.id !== action.groupId), folds })
    }
    case 'group.move': {
      const from = file.groups.findIndex((entry) => entry.id === action.groupId)
      if (from < 0) refuse('notFound', '本地分组不存在')
      const groups = moveTo(file.groups, from, action.to)
      if (groups.every((entry, index) => entry === file.groups[index])) return file
      return next({ groups })
    }
    case 'member.add': {
      const member = checkedRef(action.member)
      const target = groupOf(file, action.groupId)
      const at = target.members.findIndex((entry) => sameRef(entry, member))
      if (at >= 0) {
        if (action.to === undefined) return file
        return applyOrganizer(file, { type: 'member.move', member, to: action.to }, id)
      }
      const groups = without(file.groups, [member]).map((group) => {
        if (group.id !== target.id) return group
        const to = clamp(action.to ?? group.members.length, group.members.length)
        return {
          ...group,
          members: [...group.members.slice(0, to), member, ...group.members.slice(to)],
        }
      })
      return next({ groups })
    }
    case 'member.remove': {
      const member = checkedRef(action.member)
      if (!file.groups.some((group) => group.members.some((entry) => sameRef(entry, member))))
        return file
      return next({ groups: without(file.groups, [member]) })
    }
    case 'member.move': {
      const member = checkedRef(action.member)
      const group =
        file.groups.find((entry) => entry.members.some((ref) => sameRef(ref, member))) ??
        refuse('notFound', '成员不在本地分组里')
      const from = group.members.findIndex((ref) => sameRef(ref, member))
      const members = moveTo(group.members, from, action.to)
      if (members.every((ref, index) => ref === group.members[index])) return file
      return next({
        groups: file.groups.map((entry) => (entry.id === group.id ? { ...entry, members } : entry)),
      })
    }
    case 'pins.order': {
      if (action.base !== file.revision) refuse('conflict', '整理已在别处更新')
      const seen = new Set<string>()
      const order: PinRef[] = []
      for (const ref of action.order) {
        const key = pinKey(ref)
        if (seen.has(key)) refuse('invalid', '置顶项重复')
        seen.add(key)
        order.push(ref)
      }
      if (JSON.stringify(order) === JSON.stringify(file.pinOrder)) return file
      return next({ pinOrder: order })
    }
    case 'pins.drop': {
      const key = pinKey(action.ref)
      if (!file.pinOrder.some((ref) => pinKey(ref) === key)) return file
      return next({ pinOrder: file.pinOrder.filter((ref) => pinKey(ref) !== key) })
    }
    case 'fold': {
      if (typeof action.key !== 'string' || !action.key) refuse('invalid', '区域无效')
      if ((file.folds[action.key] === true) === action.closed) return file
      const { [action.key]: _was, ...rest } = file.folds
      return next({ folds: action.closed ? { ...rest, [action.key]: true } : rest })
    }
  }
}
