// 建议任务的几样共用的东西：取列表、到点重画、开始和不要、offer 卡上的选择、从列表回到对话里那张卡片（滚过去、闪一下）。
// 卡片在 ProposalCell.tsx，列表页在 src/screens/proposals/ProposalsScreen.tsx。
import type { SessionProposalView } from '@litch/core'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { whyNot } from '../../../../../packages/ui/src/app/errors.ts'
import type { SessionStore } from '../../core/session-store'
import { acquireStore, releaseStore } from '../../core/store-cache'
import { useChannel } from '../../shell/services'
import { useT } from '../../ui/i18n'
import { nextExpiry, type overridesFor } from './logic'

/** 这个会话的会话存储（和详情页共用一份，见 store-cache）。用完自己放掉 */
export function useSessionStore(deviceId: string, sessionId: string): SessionStore {
  const channel = useChannel()
  const store = useMemo(
    () => acquireStore(channel, deviceId, sessionId),
    [channel, deviceId, sessionId],
  )
  useEffect(() => () => releaseStore(store), [store])
  return store
}

/**
 * 这个会话上的全部提案（等着的、了结的）。还没取到是 undefined。从会话存储取，
 * 不从数据副本的 keys.proposals 取：手机上副本不开会话，那里一直是空的
 */
export function useProposalList(
  deviceId: string,
  sessionId: string,
): readonly SessionProposalView[] | undefined {
  const store = useSessionStore(deviceId, sessionId)
  return useSyncExternalStore(store.subscribeProposals, store.getProposals)
}

/**
 * 现在的时刻。等着的提案里最早过期的那一刻重画一次（设备进程到点也会发通知，界面不等它）。
 * 定时器的上限是 2^31 毫秒（二十多天）：七天的提案在这之内
 */
export function useProposalClock(
  list: readonly (SessionProposalView | null)[] | undefined,
): number {
  const [, redraw] = useState(0)
  const now = Date.now()
  const next = nextExpiry(
    (list ?? []).filter((proposal): proposal is SessionProposalView => proposal !== null),
    now,
  )
  useEffect(() => {
    if (next === null) return
    const timer = setTimeout(() => redraw((n) => n + 1), Math.max(0, next - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [next])
  return now
}

/** 一张提案上的“开始”“不要”、offer 卡上的“新会话”“在这里做”：发出去、等着、没做成的原因 */
export function useProposalAct(deviceId: string, sessionId: string, proposalId: string) {
  const channel = useChannel()
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const run = (sent: Promise<unknown>) => {
    setBusy(true)
    setFailure(null)
    sent
      .catch((error: unknown) => setFailure(t('proposal.failed', { reason: whyNot(error, t) })))
      .finally(() => setBusy(false))
  }
  return {
    busy,
    failure,
    accept: (overrides?: ReturnType<typeof overridesFor>) =>
      run(
        channel.command('session.proposal.accept', {
          deviceId,
          sessionId,
          proposalId,
          ...(overrides ? { overrides } : {}),
        }),
      ),
    dismiss: () =>
      run(channel.command('session.proposal.dismiss', { deviceId, sessionId, proposalId })),
    answer: (choice: 'session' | 'here') =>
      run(channel.command('session.proposal.answer', { deviceId, sessionId, proposalId, choice })),
    // 普通提案卡上的“在这里做”：设备进程往这个会话发“在这里做：”（界面语言）加标题和任务，回合在跑就排到回合后
    here: () =>
      run(
        channel.command('session.proposal.here', {
          deviceId,
          sessionId,
          proposalId,
          lead: t('proposal.here.lead'),
        }),
      ),
  }
}

// —— 从列表回到对话里那张卡片 ——
// 列表页记下要找哪张（requestReveal）再返回；对话区看到有它这个会话的请求就滚过去（takeReveal），
// 卡片自己看是不是刚被找的那张（useFlashed），是就描一圈强调色，过一会儿拿掉。

let pending: { deviceId: string; sessionId: string; proposalId: string } | null = null
let flashed: string | null = null
const listeners = new Set<() => void>()
const notify = () => {
  for (const listener of listeners) listener()
}
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 列表里点了一条：回到对话之后去找这张卡片 */
export function requestReveal(deviceId: string, sessionId: string, proposalId: string): void {
  pending = { deviceId, sessionId, proposalId }
  notify()
}

/** 有这个会话的请求就拿走（只拿一次）。没有是 null */
export function takeReveal(deviceId: string, sessionId: string): string | null {
  if (pending?.deviceId !== deviceId || pending.sessionId !== sessionId) return null
  const { proposalId } = pending
  pending = null
  return proposalId
}

/** 有没有这个会话的请求在等着（对话区据此去拿） */
export const useRevealWaiting = (deviceId: string, sessionId: string): boolean =>
  useSyncExternalStore(
    subscribe,
    () => pending?.deviceId === deviceId && pending.sessionId === sessionId,
  )

/** 这张卡片描一圈，1.6 秒后拿掉 */
export function flash(proposalId: string): void {
  flashed = proposalId
  notify()
  setTimeout(() => {
    if (flashed !== proposalId) return
    flashed = null
    notify()
  }, 1600)
}

export const useFlashed = (proposalId: string | undefined): boolean =>
  useSyncExternalStore(subscribe, () => proposalId !== undefined && flashed === proposalId)
