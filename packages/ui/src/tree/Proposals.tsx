// 模型提的“要不要另起一个子会话”（litch_sessions.start 降成的提案）：一张卡片，排在输入框上面，
// 和审批卡片同一个位置（没有请求等着的时候才出）。“开始”就起子会话，“不要”就收掉；
// 到了过期的时间自己收掉（设备进程那时也会发通知，这边不等它）。一次只呈现一个，其余的写个数。

import type { DeviceView } from '@litch/core'
import { keys, type SessionProposalView } from '@litch/core'
import { useEffect, useState } from 'react'
import { useT } from '../app/appearance.ts'
import { wireStyle } from '../app/device.ts'
import { whyNot } from '../app/errors.ts'
import { useKey, useServices } from '../app/services.tsx'

const NONE: readonly SessionProposalView[] = []

/** 沙箱档的名字（和三家内置的权限预设同名） */
export const SANDBOX_LEVEL = {
  'read-only': 'tree.level.readOnly',
  'workspace-write': 'tree.level.workspace',
  'danger-full-access': 'tree.level.full',
} as const

/** 三家内置的权限预设对应的沙箱档，越往后越严 */
const PRESET_LEVEL: Record<string, keyof typeof SANDBOX_LEVEL> = {
  ':danger-full-access': 'danger-full-access',
  ':workspace': 'workspace-write',
  ':read-only': 'read-only',
}
const LEVEL_RANK = { 'danger-full-access': 0, 'workspace-write': 1, 'read-only': 2 } as const

/**
 * 父会话现在的权限预设比目标 harness 给得到的每一档都严时，子会话实际会是的那一档（设备进程照同样的规矩算）。
 * 收得紧、或者认不出预设（不是内置的那三档、父会话的设置还没取到）是 null
 */
export function widerLevel(
  parentPermission: string | null | undefined,
  targetPresets: readonly string[],
): keyof typeof SANDBOX_LEVEL | null {
  const mine = parentPermission ? PRESET_LEVEL[parentPermission] : undefined
  const levels = targetPresets.flatMap((id) => PRESET_LEVEL[id] ?? [])
  if (!mine || levels.length === 0) return null
  const best = levels.reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a))
  return LEVEL_RANK[best] < LEVEL_RANK[mine] ? best : null
}

/** 还没过期的提案。到最早的那个过期的时刻重画一次 */
function useLiveProposals(list: readonly SessionProposalView[]): readonly SessionProposalView[] {
  const [, redraw] = useState(0)
  const now = Date.now()
  const live = list.filter((proposal) => proposal.expiresAt > now)
  const next = Math.min(...live.map((proposal) => proposal.expiresAt))
  useEffect(() => {
    if (!Number.isFinite(next)) return
    // 定时器的上限是 2^31 毫秒（二十多天）：七天的提案在这之内
    const timer = window.setTimeout(() => redraw((n) => n + 1), Math.max(0, next - Date.now()) + 50)
    return () => window.clearTimeout(timer)
  }, [next])
  return live
}

export function Proposals({ deviceId, sessionId }: { deviceId: string; sessionId: string }) {
  const { channel } = useServices()
  const t = useT()
  const device = useKey<DeviceView>(keys.device(deviceId))
  const list = useKey<SessionProposalView[]>(keys.proposals(deviceId, sessionId)) ?? NONE
  const live = useLiveProposals(list)
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null)
  const proposal = live[0]
  if (!proposal) return null
  const online = device?.connection === 'online'

  const run = (command: 'session.proposal.accept' | 'session.proposal.dismiss') => {
    setBusy(proposal.id)
    setFailure(null)
    channel
      .command(command, { deviceId, sessionId, proposalId: proposal.id })
      .catch((error: unknown) =>
        setFailure({
          id: proposal.id,
          text: t('tree.proposal.failed', { reason: whyNot(error, t) }),
        }),
      )
      .finally(() => setBusy(null))
  }
  const said = failure?.id === proposal.id ? failure.text : null
  return (
    <div className="req-slot" style={wireStyle(device?.wire)}>
      {/* biome-ignore lint/a11y/useSemanticElements: 一组按钮和几句话，不是表单里的一栏 */}
      <div
        className="tree-proposal"
        role="group"
        aria-label={t('tree.proposal.head')}
        data-proposal={proposal.id}
      >
        <div className="tree-proposal-text">
          <span className="tree-proposal-head">{t('tree.proposal.head')}</span>
          <b>{proposal.title}</b>
          <span className="tree-proposal-prompt">{proposal.prompt}</span>
          <span className="tree-proposal-meta">
            <span className="pill mute">
              {t(proposal.kind === 'fork' ? 'tree.proposal.fork' : 'tree.proposal.fresh')}
            </span>
            {proposal.harness ? <span className="pill mute">{proposal.harness}</span> : null}
            {live.length > 1 ? (
              <span className="dim">{t('tree.proposal.more', { n: live.length - 1 })}</span>
            ) : null}
          </span>
          {proposal.widerSandbox ? (
            <span className="tree-proposal-wider" data-wider={proposal.widerSandbox}>
              {t('tree.proposal.wider', { level: t(SANDBOX_LEVEL[proposal.widerSandbox]) })}
            </span>
          ) : null}
          {said ? <span className="err">{said}</span> : null}
        </div>
        <div className="plan-ask-acts">
          <button
            type="button"
            className="btn primary"
            data-act="start"
            disabled={busy !== null || !online}
            onClick={() => run('session.proposal.accept')}
          >
            {t('tree.proposal.start')}
          </button>
          <button
            type="button"
            className="btn ghost"
            data-act="dismiss"
            disabled={busy !== null || !online}
            onClick={() => run('session.proposal.dismiss')}
          >
            {t('tree.proposal.dismiss')}
          </button>
        </div>
      </div>
    </div>
  )
}
