import type { ManagerView } from '@litch/core'

/** 入口只排用户确认过的重置；摘要失败的再次确认才允许仅凭看板接手。 */
export function managerResetState(
  manager: Pick<ManagerView, 'harness' | 'status' | 'reset'>,
  online: boolean,
  sending = false,
) {
  const phase = manager.reset?.phase
  const busy = sending || ['waiting', 'summarizing', 'applying'].includes(phase ?? '')
  const boardOnly = phase === 'summaryFailed'
  return {
    replace: manager.reset ? manager.reset.mode === 'replace' : manager.harness !== 'claude-code',
    attention:
      manager.status === 'active' &&
      (manager.reset?.outdated === true || phase === 'failed' || boardOnly),
    boardOnly,
    disabled:
      manager.status !== 'active'
        ? ('manager.readOnly' as const)
        : !online
          ? ('manager.offline' as const)
          : busy
            ? ('manager.resetWaiting' as const)
            : null,
  }
}
