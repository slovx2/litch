// 桌面外壳的预加载脚本挂在 window.litchApprovals 上的手机批准钥匙接口（apps/desktop/src/approvals/bridge.mts，
// 消息名和形状在 apps/desktop/src/approvals/ipc.mts），这里是界面这边的类型，改一边要改另一边。
// 普通浏览器（对着模拟核心的预览）里没有，设备详情里就不显示批准钥匙。
import { useEffect, useState } from 'react'

export interface TrustedPhoneEntry {
  phoneId: string
  name: string
  /** 4 组 4 个十六进制字 */
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

export interface ApprovalsBridge {
  list(): Promise<TrustedPhoneEntry[]>
  forget(phoneId: string): Promise<boolean>
  onChanged(handler: () => void): () => void
  onNotice(handler: (notice: ApprovalNotice) => void): () => void
}

declare global {
  interface Window {
    litchApprovals?: ApprovalsBridge
  }
}

/** 外壳给的接口。普通浏览器里、单元测试里没有 */
export const approvalsBridge = (): ApprovalsBridge | undefined =>
  typeof window === 'undefined' ? undefined : window.litchApprovals

/** 记下的手机（没有外壳时是 null），记下的变了跟着重取 */
export function useTrustedPhones(): TrustedPhoneEntry[] | null {
  const [phones, setPhones] = useState<TrustedPhoneEntry[] | null>(null)
  useEffect(() => {
    const bridge = approvalsBridge()
    if (!bridge) return
    let live = true
    const load = () => {
      bridge.list().then(
        (listed) => {
          if (live) setPhones(listed)
        },
        () => {},
      )
    }
    load()
    const stop = bridge.onChanged(load)
    return () => {
      live = false
      stop()
    }
  }, [])
  return phones
}
