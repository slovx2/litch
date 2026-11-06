import { type PairPayload, possibleTailnetHost } from '@litch/core'
import type { TailscaleStatus } from './tailscale'

export type PairNetworkPrompt = 'account' | 'login' | null

/** 二维码提示与本机特征取并集；这不是 SSH 模式判定，也不替代拨号层选路。 */
export function pairNetworkPrompt(
  payload: PairPayload,
  status: TailscaleStatus | null,
): PairNetworkPrompt {
  const possible =
    payload.ts === 1 ||
    payload.m === 'tailscale' ||
    possibleTailnetHost(payload.h, status?.hosts ?? [])
  if (!possible) return null
  return status?.tailnet && status.state !== 'needsLogin' ? 'account' : 'login'
}

/** 登录页返回后，只有连通的内置网络才能自动续配；取消、待批准或掉线都留在确认页。 */
export const canResumePairing = (status: TailscaleStatus | null, completed: boolean): boolean =>
  completed && status?.state === 'connected'
