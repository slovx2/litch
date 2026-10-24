// 手机批准钥匙在主进程、工具进程（核心）、界面之间的消息名和形状。预加载脚本在沙箱里只认打包进去的纯代码，
// 所以这里不引 Node 的模块；实现在 approvals/main.mts。
// 界面经预加载脚本拿到 window.litchApprovals = { list(), forget(phoneId), enabled(), setEnabled(on), onChanged(cb), onNotice(cb) }，
// 类型在 packages/ui/src/devices/approvals-bridge.ts 照抄一份，改一边要改另一边。

/**
 * 工具进程 → 主进程：扫码绑定时人核对过确认码、点了允许，手机带了批准公钥（trust）；
 * 撤销了一部手机（forget）。只有这两种，记下的钥匙只由主进程读写
 */
export const APPROVAL_KEYS = 'approvalKeys'
export type ApprovalKeysMessage =
  | {
      type: typeof APPROVAL_KEYS
      op: 'trust'
      deviceId: string
      pairId: string
      phoneId: string
      name: string
      /** 手机的公钥行，重算确认码用 */
      publicKey: string
      approvalKey: string
      /** 人核对过的确认码 */
      code: string
    }
  | { type: typeof APPROVAL_KEYS; op: 'forget'; phoneId: string }

/** 界面 → 主进程，等应答：记下的手机（TrustedPhoneEntry[]） */
export const APPROVALS_LIST = 'litch:approvals:list'
/** 界面 → 主进程，等应答：删掉一部手机的批准钥匙，回删没删掉 */
export const APPROVALS_FORGET = 'litch:approvals:forget'
/** 界面 → 主进程，等应答：手机远程批准开没开（实验功能，默认关） */
export const APPROVALS_ENABLED = 'litch:approvals:enabled'
/** 界面 → 主进程，等应答：打开、关掉手机远程批准，回改后的值 */
export const APPROVALS_SET_ENABLED = 'litch:approvals:setEnabled'
/** 主进程 → 界面：记下的手机或开关变了（不带内容，界面再取一次） */
export const APPROVALS_CHANGED = 'litch:approvals:changed'
/** 主进程 → 界面：第一次记下一部手机、某部手机的钥匙对不上（ApprovalNotice），界面出一条不挡事的提示 */
export const APPROVALS_NOTICE = 'litch:approvals:notice'

/** 给界面的一条记录 */
export interface TrustedPhoneEntry {
  phoneId: string
  name: string
  /** 批准钥匙的指纹，4 组 4 个十六进制字 */
  fingerprint: string
  /** pairing：扫码时核对过；firstApproval：第一次批准时记下 */
  source: 'pairing' | 'firstApproval'
  /** 经哪台设备记下的，不知道是 null */
  deviceId: string | null
  addedAt: number
  lastApprovedAt: number | null
  /** 同一手机号带来过别的钥匙，两把都不认 */
  conflict: boolean
}

export type ApprovalNotice =
  | { kind: 'firstSeen'; phoneId: string; name: string; fingerprint: string }
  | { kind: 'mismatch'; phoneId: string; name: string }
