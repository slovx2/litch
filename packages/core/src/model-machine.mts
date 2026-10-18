// 远程设备操作本机（命名空间 litch_machine）在核心和界面之间的形状。
//
// 三处界面要用：
// - 设备设置页：远程设备的“操作这台电脑（命令与文件）”一项（DeviceView.machine）；
// - 卡片：找得到会话的放进那个会话的请求里（ClientAskRequest，ask.kind 是 machine）；
//   找不到会话的放进全局待处理（主题 machine 的 pending）；
// - 顶栏标记和它的弹层：远程会话在这台电脑上起的、还在跑的进程，和全局待处理（主题 machine）。
// 操作记录按设备取（命令 machine.log），不走订阅。
import type { ApprovalOption } from './model.mjs'
import type { Text } from './phrase.mjs'

/** 审批方式：session 每个会话确认一次（默认）；each 逐条确认执行和写入；never 不确认 */
export type MachineApproval = 'session' | 'each' | 'never'

/** 访问范围：sensitive 禁止常用敏感位置（默认）；open 全放开；custom 自定义禁止位置 */
export type MachineAccessMode = 'sensitive' | 'open' | 'custom'

/** 设备设置页上“操作这台电脑”一项的现值。只有远程设备有，本机设备是 null */
export interface MachineAccessView {
  /** 开关，默认关 */
  enabled: boolean
  approval: MachineApproval
  access: {
    mode: MachineAccessMode
    /** 自定义的禁止位置（mode 是 custom 时才用）。第一次切到 custom 时由核心从内置名单抄一份 */
    custom: string[]
  }
  /** 内置的“常用敏感位置”名单（显示用，也是自定义的起点）。路径以 ~ 开头的是主目录下的 */
  presets: string[]
}

/** 调用要做的事，卡片按它拼文字 */
export type MachineAction = 'exec' | 'write' | 'read' | 'list' | 'copy' | 'process'

/** 卡片里 litch_machine 那一种（ClientAskView 的一员） */
export interface MachineAskView {
  kind: 'machine'
  action: MachineAction
  /** exec：完整的命令 */
  command: string | null
  /** exec：工作目录 */
  cwd: string | null
  /** read、write、list：路径 */
  path: string | null
  /** copy：从哪到哪。machine 是给人看的机器名 */
  copy: { from: { machine: string; path: string }; to: { machine: string; path: string } } | null
  /** 命令里提到的禁止位置（已经“本会话都允许”也再弹一次，卡片标红）。没有是空的 */
  flagged: string[]
  /** “逐条确认”下执行、写入类的卡片：每次都问，卡片上没有“本会话都允许” */
  perCall?: boolean
}

/** 远程会话在这台电脑上起的一个进程（顶栏弹层里的一行） */
export interface MachineProcessView {
  id: string
  /** 哪台设备上的会话起的 */
  deviceId: string
  deviceName: Text
  /** 哪个会话，不知道是 null（命令行调用、找不到会话） */
  sessionId: string | null
  harness: string | null
  command: string
  cwd: string
  /** 毫秒时间戳 */
  startedAt: number
}

/** 全局待处理里的一张卡片：找不到会话的调用（入口二） */
export interface MachinePendingView {
  id: string
  deviceId: string
  deviceName: Text
  /** 远程设备的主机名，卡片上写出来 */
  host: string
  harness: string | null
  ask: MachineAskView
  /** acceptSession 在这里的意思是“这台设备上找不到会话的调用都允许”，到 Litch 重启或开关关掉为止 */
  options: ApprovalOption[]
  /** 毫秒时间戳。到点没答当作拒绝（10 分钟） */
  expiresAt: number
}

/** 主题 machine 的数据 */
export interface MachineActivityView {
  running: MachineProcessView[]
  pending: MachinePendingView[]
}

/** 主题 machine 的增量：数据量小，整份换 */
export type MachineOp = { op: 'machine.set'; view: MachineActivityView }

/** 操作记录里的一条（只存在本机，按设备、条数有上限） */
export interface MachineLogEntry {
  /** 毫秒时间戳 */
  at: number
  deviceId: string
  sessionId: string | null
  harness: string | null
  tool: string
  /** 命令，或者路径，或者“从哪到哪” */
  summary: string
  result: 'ok' | 'failed' | 'declined' | 'blocked' | 'expired' | 'disabled'
  /** 碰到了禁止位置（不确认那档下照样跑了的，在这里标出来） */
  flagged: boolean
}
