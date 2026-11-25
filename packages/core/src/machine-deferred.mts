import type { ClientToolCallResponse } from '../../protocol/src/client-tools.mjs'
import {
  MACHINE_APPROVAL_METHOD as M,
  MACHINE_APPROVAL_TTL_MS,
  type MachineApprovalCard,
} from '../../protocol/src/machine-approvals.mjs'
import { type Cancel, createCancel } from './channel/cancel.mjs'
import type { AbortSignalLike, Clock } from './channel/protocol.mjs'
import type { MachineApprovalRequest } from './device/machine/types.mjs'
import type { MachineCallInput } from './device/tool-calls.mjs'
import type { MachineDeviceLink } from './machine-wiring.mjs'
import type { MachineDeferredView } from './model-machine.mjs'

type Decision = 'once' | 'timed' | 'decline'

interface Held {
  view: MachineDeferredView
  link: MachineDeviceLink
  timer: ReturnType<Clock['setTimer']>
  abort: Cancel
  execute(signal: AbortSignalLike): Promise<ClientToolCallResponse>
  started: boolean
  busy: boolean
}

interface Options {
  clock: Clock
  desktop: string
  randomId?(): string
  changed(): void
  grant(device: string, thread: string, hours: number): Promise<unknown>
  notify(view: MachineDeferredView): void
  log(line: string): void
}

/** 审批与执行在控制端；设备即使能造出通知，也没有批准的入口。 */
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
  const run = async (entry: Held) => {
    let response: ClientToolCallResponse
    try {
      response = await entry.execute(entry.abort.signal)
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
  return {
    views(): MachineDeferredView[] {
      return [...held.values()].flatMap((entry) => (entry.started ? [] : [entry.view]))
    },
    async submit(
      deviceId: string,
      link: MachineDeviceLink,
      input: MachineCallInput & { threadId: string },
      request: MachineApprovalRequest,
      details: string,
      execute: Held['execute'],
    ): Promise<boolean> {
      const { action, command, path, cwd } = request.ask
      if (action !== 'exec' && action !== 'read' && action !== 'write' && action !== 'list')
        return false
      const target = command ?? path
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
      }
      const entry: Held = {
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
    async answer(
      deviceId: string,
      id: string,
      decision: Decision,
      hours?: number,
    ): Promise<boolean> {
      const entry = held.get(id)
      if (
        !entry ||
        entry.view.deviceId !== deviceId ||
        entry.busy ||
        entry.started ||
        entry.view.expiresAt <= host.clock.now()
      )
        return false
      entry.busy = true
      const { threadId } = entry.view
      try {
        if (decision === 'decline') {
          await finish(entry, 'rejected')
          return true
        }
        if (decision === 'timed' && hours !== undefined) await host.grant(deviceId, threadId, hours)
        if (held.get(id) !== entry || entry.view.expiresAt <= host.clock.now()) return false
        await entry.link.request(M.start, { id, threadId })
        if (held.get(id) !== entry || !entry.link.online()) return false
        entry.started = true
        entry.timer()
        host.changed()
        void run(entry)
        return true
      } finally {
        entry.busy = false
      }
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
