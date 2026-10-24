// 原生 codex 的速度（serviceTier）按会话记住：客户端选过的由设备进程记下，恢复、分叉没带时补回。
//
// codex 不保存速度（实测 0.160.0、0.163.0；源码 rust-v0.163.0 app-server 的 merge_persisted_resume_metadata
// 只从记录里取回模型和强度，persisted_resume_settings 只取审批与权限）。会话装载着时一直沿用上一次选的；
// 从磁盘重新装载过（codex 重启，或者没人订阅、空闲满 thread_unload_delay_secs 被卸载：0.160.0 默认 60 秒、
// 0.163.0 默认 30 分钟）之后，thread/resume 报的和发给模型的都回到配置里的 service_tier。客户端恢复时只带会话号，
// 选过的快速就悄悄没了：界面显示标准，回合也按标准跑。分叉也一样不接着源会话的速度。
//
// 所以：
//   - 记：转给 codex 的 thread/start、thread/resume、thread/fork、turn/start、thread/settings/update 里明着带了
//     serviceTier 的，成了才记（字符串记下；null 是回到配置的默认，删掉记录）。建会话、分叉的会话号在应答里。
//     turn/start 的 serviceTierForTurn 只管那一个回合，不记。
//   - 补：thread/resume 没带 serviceTier 时带上记下的；thread/fork 没带时带上源会话记下的，分叉出来的会话也记一份。
//     会话还装载着时 codex 忽略恢复带的这一项、报它正在用的（实测），所以总带着也不会改掉刚选的。
// 两条路各记各的：经设备服务的由设备进程记在 sessions.sqlite（packages/device 的 session.mts、engine-link.mts），
// 直连原生 codex 的由核心记在这台电脑的侧栏快照里（packages/core 的 live.mts）。

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 按会话记的速度 */
export interface SpeedStore {
  speed(threadId: string): string | null
  /** null：删掉记录 */
  setSpeed(threadId: string, speed: string | null): void
}

/** 补好的参数，和应答回来之后要做的（记下这个会话的速度） */
export interface PreparedSpeed {
  params: Record<string, unknown>
  remember(result: unknown): void
}

const createdId = (result: unknown): string | null => {
  const thread = isObject(result) ? result.thread : null
  return isObject(thread) && typeof thread.id === 'string' ? thread.id : null
}

/** 不用改、也不用记的返回 null */
export function prepareSpeed(
  method: string,
  params: Record<string, unknown>,
  store: SpeedStore,
): PreparedSpeed | null {
  const given = 'serviceTier' in params
  const chosen = params.serviceTier
  // 带了却既不是字符串也不是 null：codex 会拒掉，这里不记
  if (given && chosen !== null && typeof chosen !== 'string') return null
  const speed = (chosen ?? null) as string | null
  const threadId = typeof params.threadId === 'string' ? params.threadId : null
  switch (method) {
    case 'thread/start':
      if (!given) return null
      return {
        params,
        remember(result) {
          const id = createdId(result)
          if (id) store.setSpeed(id, speed)
        },
      }
    case 'turn/start':
    case 'thread/settings/update':
    case 'thread/resume': {
      if (!threadId) return null
      if (given) return { params, remember: () => store.setSpeed(threadId, speed) }
      if (method !== 'thread/resume') return null
      const kept = store.speed(threadId)
      return kept ? { params: { ...params, serviceTier: kept }, remember() {} } : null
    }
    case 'thread/fork': {
      const inherited = given ? speed : threadId ? store.speed(threadId) : null
      if (!given && !inherited) return null
      return {
        params: given ? params : { ...params, serviceTier: inherited },
        remember(result) {
          const id = createdId(result)
          if (id) store.setSpeed(id, inherited)
        },
      }
    }
    default:
      return null
  }
}
