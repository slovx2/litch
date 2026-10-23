// 更新横条（screens/devices/UpdateBanner.tsx）要不要说一次失败：人点了“更新”之后（下载、校验、安装）失败的才说，
// 后台查的时候连不上、清单读不了不说（只在设置页的“关于”里），免得没网时横条一直挂着。
// 人在横条上关掉的那一份安装包不再说；清单换了新的包、再失败时再说。
import type { UpdateFailure, UpdateSnapshot } from './store'

/** 横条上要说的失败；不说是 null */
export function bannerFailure({
  state,
  dismissed,
}: Pick<UpdateSnapshot, 'state' | 'dismissed'>): UpdateFailure | null {
  if (state.phase !== 'failed' || state.download === undefined) return null
  return state.download === dismissed ? null : state.reason
}
