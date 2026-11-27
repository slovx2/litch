import type { ClientToolCallResponse } from '../../protocol/src/client-tools.mjs'
import {
  isMachineApprovalReview,
  isMachinePhoneAnswer,
  MACHINE_APPROVAL_METHOD as M,
  MACHINE_APPROVAL_DETAILS_MAX,
  MACHINE_APPROVAL_REVIEW_VERSION,
  MACHINE_APPROVAL_TTL_MS,
  type MachineApprovalCard,
  type MachinePhoneAnswer,
  machineApprovalPayload,
  matchesMachinePhoneAnswer,
} from '../../protocol/src/machine-approvals.mjs'
import { type Cancel, createCancel } from './channel/cancel.mjs'
import type { AbortSignalLike, Clock } from './channel/protocol.mjs'
import type { MachineApprovalRequest } from './device/machine/types.mjs'
import type { MachineDeviceLink } from './machine-wiring.mjs'
import type { MachineDeferredView } from './model-machine.mjs'

type Decision = 'once' | 'timed' | 'always' | 'decline'

interface Held {
  card: MachineApprovalCard
  view: MachineDeferredView
  link: MachineDeviceLink
  timer: ReturnType<Clock['setTimer']>
  abort: Cancel
  execute(
    signal: AbortSignalLike,
    decision: Decision,
    hours?: number,
  ): Promise<ClientToolCallResponse>
  started: boolean
  busy: boolean
}

export interface MachineApprovalSigner {
  desktopId: string
  hash(text: string): string
  verify(deviceId: string, card: MachineApprovalCard, answer: MachinePhoneAnswer): Promise<boolean>
}

interface Options {
  clock: Clock
  desktop: string
  randomId?(): string
  signing?: MachineApprovalSigner
  signingAvailable?(deviceId: string): boolean
  changed(): void
  grant(device: string, thread: string, hours: number, valid: () => boolean): Promise<unknown>
  notify(view: MachineDeferredView): void
  log(line: string): void
}

/** 审批与执行在控制端；远端答复只能由本机核对签名后进入答卡流程。 */
export function createMachineDeferred(host: Options) {
  const held = new Map<string, Held>()
  const remove = (entry: Held) => {
    entry.timer()
    if (held.delete(entry.view.id)) host.changed()
  }
  const finish = async (
    entry: Held,
    outcome: 'completed' | 'failed' | 'stopped' | 'rejected' | 'expired' | 'lost',
    text?: string,
  ) => {
    remove(entry)
    await entry.link
      .request(M.finish, {
        id: entry.view.id,
        threadId: entry.view.threadId,
        outcome,
        ...(text ? { text: text.slice(0, 16 * 1024) } : {}),
      })
      .catch((error: unknown) => host.log(`异步本机操作结果未确认：${String(error)}`))
  }
  const run = async (entry: Held, decision: Decision, hours?: number) => {
    let response: ClientToolCallResponse
    try {
      response = await entry.execute(entry.abort.signal, decision, hours)
    } catch {
      await finish(entry, 'failed', 'The executing desktop could not finish the operation.')
      return
    }
    const text = response.contentItems
      .flatMap((item) => (item.type === 'inputText' ? [item.text] : []))
      .join('\n')
    const result =
      response.success &&
      (entry.view.ask.action !== 'exec' || /^status: exited\nexit_code: 0(?:\n|$)/.test(text))
    await finish(
      entry,
      result ? 'completed' : entry.abort.signal.aborted ? 'stopped' : 'failed',
      text,
    )
  }
  const answer = async (
    deviceId: string,
    id: string,
    decision: Decision,
    hours?: number,
    proof?: MachinePhoneAnswer,
  ): Promise<boolean> => {
    const entry = held.get(id)
    if (
      !entry ||
      (decision === 'always' && entry.card.retry?.always !== true) ||
      entry.view.deviceId !== deviceId ||
      entry.busy ||
      entry.started ||
      entry.view.expiresAt <= host.clock.now() ||
      !entry.link.online()
    )
      return false
    entry.busy = true
    const { threadId } = entry.view
    const current = () =>
      held.get(id) === entry && entry.link.online() && entry.view.expiresAt > host.clock.now()
    try {
      if (
        proof &&
        (!matchesMachinePhoneAnswer(entry.card, proof) ||
          !(await host.signing?.verify(deviceId, entry.card, proof)))
      )
        return false
      if (!current()) return false
      if (decision === 'decline') {
        await finish(entry, 'rejected')
        return true
      }
      await entry.link.request(M.start, { id, threadId })
      if (!current()) {
        if (held.get(id) === entry) await finish(entry, 'lost')
        return false
      }
      entry.started = true
      entry.timer()
      host.changed()
      if (decision === 'timed' && hours !== undefined && !entry.card.retry) {
        // 授时失败明确结束任务，避免界面误报授时成功。
        try {
          await host.grant(deviceId, threadId, hours, current)
        } catch (error) {
          await finish(entry, 'failed', 'Could not grant timed approval. Nothing was started.')
          host.log(`本机操作限时授权失败：${String(error)}`)
          return false
        }
      }
      if (!current()) {
        if (held.get(id) === entry) await finish(entry, 'lost')
        return false
      }
      void run(entry, decision, hours)
      return true
    } finally {
      entry.busy = false
    }
  }
  return {
    views(): MachineDeferredView[] {
      return [...held.values()].flatMap((entry) => (entry.started ? [] : [entry.view]))
    },
    async submit(
      deviceId: string,
      link: MachineDeviceLink,
      input: { threadId: string; turnId: string | null; callId: string; signal: AbortSignalLike },
      request: MachineApprovalRequest,
      details: string,
      snapshot: string,
      execute: Held['execute'],
      retry?: MachineApprovalCard['retry'],
    ): Promise<boolean> {
      const { action, command, path, cwd } = request.ask
      if (action === 'process' || (action === 'access') !== !!retry) return false
      const target = command ?? path ?? request.ask.copy?.to.path
      if (!target || target.length > 4096 || input.signal.aborted) return false
      const id = host.randomId?.()
      if (!id) return false
      const expiresAt = host.clock.now() + MACHINE_APPROVAL_TTL_MS
      const card: MachineApprovalCard = {
        id,
        threadId: input.threadId,
        turnId: input.turnId,
        action,
        target,
        cwd,
        desktop: host.desktop.slice(0, 200),
        expiresAt,
        ...(retry ? { retry } : {}),
      }
      const signing = host.signing
      if (
        signing &&
        host.signingAvailable?.(deviceId) &&
        details.length <= MACHINE_APPROVAL_DETAILS_MAX
      ) {
        const nonce = host.randomId?.()
        if (nonce) {
          const review = {
            desktopId: signing.desktopId,
            nonce,
            version: MACHINE_APPROVAL_REVIEW_VERSION,
            details,
            snapshotHash: signing.hash(snapshot),
          } as const
          const signedReview = {
            ...review,
            payloadHash: signing.hash(machineApprovalPayload(card, review)),
          }
          if (isMachineApprovalReview(signedReview)) card.review = signedReview
        }
      }
      try {
        await link.request(M.open, { ...card, callId: input.callId })
      } catch (error) {
        host.log(`不能提交异步本机操作：${String(error)}`)
        return false
      }
      const view: MachineDeferredView = {
        id,
        threadId: input.threadId,
        deviceId,
        ask: request.ask,
        details,
        expiresAt,
        ...(retry ? { retry: { always: retry.always } } : {}),
      }
      const entry: Held = {
        card,
        view,
        link,
        execute,
        timer: host.clock.setTimer(() => {
          if (!entry.started) void finish(entry, 'expired')
        }, MACHINE_APPROVAL_TTL_MS),
        abort: createCancel(),
        started: false,
        busy: false,
      }
      held.set(id, entry)
      if (input.signal.aborted || !link.online()) {
        await finish(entry, 'lost')
        return false
      }
      host.changed()
      host.notify(view)
      return true
    },
    answer,
    answerSigned(deviceId: string, proof: unknown): Promise<boolean> {
      if (!isMachinePhoneAnswer(proof)) return Promise.resolve(false)
      return answer(deviceId, proof.id, proof.decision, proof.hours, proof)
    },
    stop(deviceId: string, id: string, threadId: string): void {
      const entry = held.get(id)
      if (entry?.view.deviceId === deviceId && entry.view.threadId === threadId) entry.abort.abort()
    },
    stopAll(deviceId?: string, disconnected = false): void {
      for (const entry of held.values()) {
        if (deviceId !== undefined && entry.view.deviceId !== deviceId) continue
        entry.abort.abort()
        if (disconnected) remove(entry)
        else if (!entry.started) void finish(entry, 'lost')
      }
    },
  }
}
