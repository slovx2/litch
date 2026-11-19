import { randomUUID } from 'node:crypto'
import type { RemoteChromeDecision, RemoteChromePrompt } from '../../protocol/src/remote-chrome.mjs'
import type { ChromeAsk, ChromeScope } from './remote-chrome-runtime.mjs'
import { isObject } from './wire.mjs'

export type ChromeApprovalDelivery = (
  prompt: RemoteChromePrompt,
  signal: AbortSignal,
) => Promise<unknown>

/** 开卡请求只发给选定的桌面连接；手机只收到投影，答复不经过手机批准通道。 */
export async function requestChromeApproval(options: {
  scope: ChromeScope
  callId: string
  ask: ChromeAsk
  hostLabel: string
  signal: AbortSignal
  deliver: ChromeApprovalDelivery | null
  project(prompt: RemoteChromePrompt): () => void
}): Promise<RemoteChromeDecision | null> {
  if (!options.deliver || options.signal.aborted) return null
  const timeout = 5 * 60_000
  const prompt: RemoteChromePrompt = {
    id: randomUUID(),
    nonce: randomUUID(),
    expiresAt: Date.now() + timeout,
    threadId: options.scope.threadId,
    turnId: options.scope.turnId,
    callId: options.callId,
    hostLabel: options.hostLabel,
    kind: options.ask.kind === 'site' ? 'site' : 'signIn',
    origin: options.ask.origin,
    ...(options.ask.kind === 'chromeSignIn' ? { reason: options.ask.reason } : {}),
  }
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
  const dismiss = options.project(prompt)
  try {
    const answer = await options.deliver(prompt, signal)
    if (
      signal.aborted ||
      Date.now() >= prompt.expiresAt ||
      !isObject(answer) ||
      answer.id !== prompt.id ||
      answer.nonce !== prompt.nonce
    )
      return null
    const decision = answer.decision
    if (decision === 'once' || decision === 'decline') return decision
    return prompt.kind === 'site' && (decision === 'session' || decision === 'always')
      ? decision
      : null
  } catch {
    return null
  } finally {
    dismiss()
  }
}
