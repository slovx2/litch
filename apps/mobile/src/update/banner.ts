// 更新横条（screens/devices/UpdateBanner.tsx）要不要说一次失败：人点了“更新”、下下来对不上才说。
// 后台查的时候连不上、清单读不了不说（只在设置页的“关于”里），免得没网时横条一直挂着。
import type { MobileUpdateState, UpdateFailure } from './store'

/** 下下来之后才会出的失败 */
const AFTER_DOWNLOAD: ReadonlySet<UpdateFailure> = new Set([
  'size',
  'checksum',
  'package',
  'signature',
  'install',
])

/** 横条上要说的失败；不说是 null */
export function bannerFailure(state: MobileUpdateState): UpdateFailure | null {
  return state.phase === 'failed' && AFTER_DOWNLOAD.has(state.reason) ? state.reason : null
}
