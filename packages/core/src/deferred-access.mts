import type { ClientToolCallResponse } from '../../protocol/src/client-tools.mjs'
import type { MachineAccessNamespace } from '../../protocol/src/machine-approvals.mjs'
import type { AbortSignalLike } from './channel/protocol.mjs'
import type { ClientAskView } from './model.mjs'

export interface AccessSubject {
  namespace: MachineAccessNamespace
  key: string
  target: string
  details: string
  always: boolean
}

export interface DeferredAccessRequest {
  threadId: string
  turnId: string | null
  callId: string
  signal: AbortSignalLike
  subject: AccessSubject
  valid(): boolean
}

export const accessSubmitted: ClientToolCallResponse = {
  success: true,
  contentItems: [
    {
      type: 'inputText',
      text: 'Submitted an approval card for this target. If approved, Litch will notify this conversation when it may retry. Do not retry or take another route while waiting.',
    },
  ],
}

export const accessApproved: ClientToolCallResponse = {
  success: true,
  contentItems: [
    {
      type: 'inputText',
      text: 'The user approved access to this target for this conversation. You may now retry the same operation. If the previous call had several steps, inspect the current state and continue only the unfinished step.',
    },
  ],
}

/** 主进程确认过的实际目标才可以生成授权。登录与开启开关永远不在这里。 */
export function accessSubject(
  ask: ClientAskView,
  tool: string,
  args: unknown,
): AccessSubject | null {
  const subject = (
    namespace: AccessSubject['namespace'],
    fields: object,
    target: string,
    always = false,
  ) => ({
    namespace,
    key: JSON.stringify(fields),
    target,
    details: JSON.stringify(fields, null, 2),
    always,
  })
  switch (ask.kind) {
    case 'site':
      return subject(
        'litch_browser',
        {
          browser: ask.browser ?? 'builtin',
          origin: ask.origin,
          ...(ask.remoteHost ? { device: ask.remoteHost } : {}),
        },
        ask.origin,
        true,
      )
    case 'chromeInstance':
      return subject(
        'litch_browser',
        { browser: 'chrome', instanceId: ask.instanceId, name: ask.name },
        ask.name,
      )
    case 'chromeTab': {
      const { tabId, browser } = (args ?? {}) as { tabId?: unknown; browser?: unknown }
      if (typeof tabId !== 'string') return null
      return subject(
        'litch_browser',
        { browser: browser ?? 'chrome', tabId, url: ask.url, title: ask.title },
        ask.title || ask.url,
      )
    }
    case 'browserDownload': {
      if (tool === 'evaluate') return null
      return subject(
        'litch_browser',
        {
          filename: ask.filename,
          origin: ask.origin,
          bytes: ask.totalBytes,
          tool,
          arguments: args,
        },
        ask.filename,
      )
    }
    default:
      return null
  }
}

/** 一张卡只授予发卡会话的指定对象；单次授权一经下一次匹配的调用取得就作废。 */
export function createScopedAccess(now: () => number) {
  const entries = new Map<string, { expires: number; once: boolean }>()
  const key = (deviceId: string, threadId: string, subject: AccessSubject) =>
    JSON.stringify([deviceId, threadId, subject.namespace, subject.key])
  return {
    grant(
      deviceId: string,
      threadId: string,
      subject: AccessSubject,
      hours: number | 'always' | null,
    ) {
      for (const [id, grant] of entries) if (grant.expires <= now()) entries.delete(id)
      const expires = hours === 'always' ? Infinity : now() + (hours ?? 1) * 3_600_000
      entries.set(key(deviceId, threadId, subject), { expires, once: hours === null })
    },
    use(deviceId: string, threadId: string, subject: AccessSubject) {
      const id = key(deviceId, threadId, subject)
      const grant = entries.get(id)
      if (!grant) return false
      if (grant.once || grant.expires <= now()) entries.delete(id)
      return grant.expires > now()
    },
    clear(deviceId: string, threadId?: string) {
      const prefix =
        JSON.stringify(threadId === undefined ? [deviceId] : [deviceId, threadId]).slice(0, -1) +
        ','
      for (const id of entries.keys()) if (id.startsWith(prefix)) entries.delete(id)
    },
  }
}
