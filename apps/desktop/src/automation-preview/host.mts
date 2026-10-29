import {
  type AutomationPreviewCommand,
  type AutomationPreviewOwner,
  type AutomationPreviewView,
  previewOwnerKey,
} from '@litch/core'
import {
  type AutomationPointerSample,
  type AutomationSurface,
  isCurrentAutomationPointer,
  sameAutomationSurface,
} from '../../../../packages/protocol/src/automation-surface.mjs'
import type { ClientToolInvocation } from '../client-tools/types.mjs'
import type { HelperAccess } from '../computer-use/executor-shared.mjs'

export const AUTOMATION_PREVIEW = 'automationPreview'
export function createAutomationPreviewHost(
  helper: HelperAccess,
  publish: (view: AutomationPreviewView | null, owner: AutomationPreviewOwner) => void,
) {
  const owners = new Map<string, AutomationPreviewOwner>()
  const views = new Map<string, AutomationPreviewView>()
  const watching = new Set<string>()
  const sessionFor = (owner: AutomationPreviewOwner) =>
    [...owners].find(
      ([, one]) => one.deviceId === owner.deviceId && one.sessionId === owner.sessionId,
    )?.[0]
  const update = (session: string, view: AutomationPreviewView) => {
    views.set(session, view)
    publish(view, view.owner)
  }
  return {
    register(invocation: ClientToolInvocation, session: string) {
      owners.set(session, { deviceId: invocation.device.id, sessionId: invocation.threadId })
    },
    receive(raw: unknown) {
      if (!raw || typeof raw !== 'object') return
      const notice = raw as Record<string, unknown>
      if (typeof notice.session !== 'string') return
      const session = notice.session,
        owner = owners.get(session)
      if (!owner) return
      if (notice.event === 'removed') {
        const failed = views.get(session)
        if (
          failed &&
          ['capturePending', 'captureDenied', 'captureFailed'].includes(failed.status)
        ) {
          update(session, { ...failed, surface: null, pointer: null, frame: null, pinned: false })
          owners.delete(session)
          return
        }
        views.delete(session)
        owners.delete(session)
        publish(null, owner)
        return
      }
      let view: AutomationPreviewView = views.get(session) ?? {
        owner,
        app: '',
        surface: null,
        pointer: null,
        frame: null,
        status: 'ready',
        foreground: false,
        pinned: false,
        updatedAt: Date.now(),
      }
      if (notice.event === 'pin') {
        view = { ...view, pinned: notice.pinned === true }
      } else if (notice.event === 'surface') {
        const surface = notice.surface as AutomationSurface | undefined
        if (
          !surface ||
          !sameAutomationSurface(surface, surface) ||
          !Number.isFinite(surface.width) ||
          surface.width <= 0 ||
          !Number.isFinite(surface.height) ||
          surface.height <= 0
        )
          return
        const previousSurface = view.surface
        view = {
          ...view,
          surface,
          app: typeof notice.app === 'string' ? notice.app : '',
          pointer: null,
          frame: null,
        }
        // 面板意图独立于助手会话，跨回合、权限重试和助手重连后仍有效。
        if (
          watching.has(previewOwnerKey(owner)) &&
          (!previousSurface || !sameAutomationSurface(previousSurface, surface))
        )
          void helper.connected?.request('previewSubscribe', { session }).catch(() => {})
      } else if (notice.event === 'pointer') {
        const pointer = notice.pointer as AutomationPointerSample | undefined
        if (
          !view.surface ||
          !pointer ||
          !isCurrentAutomationPointer(view.surface, pointer, view.pointer ?? undefined)
        )
          return
        view = { ...view, pointer, foreground: view.foreground || notice.foreground === true }
      } else if (notice.event === 'frame') {
        const surface = notice.surface as AutomationSurface | undefined
        if (
          !view.surface ||
          !surface ||
          !sameAutomationSurface(view.surface, surface) ||
          typeof notice.data !== 'string' ||
          notice.data.length > 524288 ||
          typeof notice.streamId !== 'string' ||
          !Number.isSafeInteger(notice.seq) ||
          typeof notice.pixelWidth !== 'number' ||
          typeof notice.pixelHeight !== 'number' ||
          notice.pixelWidth <= 0 ||
          notice.pixelHeight <= 0
        )
          return
        view = {
          ...view,
          frame: {
            data: notice.data,
            mime: 'image/jpeg',
            streamId: notice.streamId,
            seq: notice.seq as number,
            pixelWidth: notice.pixelWidth,
            pixelHeight: notice.pixelHeight,
            contentRect: { x: 0, y: 0, width: notice.pixelWidth, height: notice.pixelHeight },
            cursorComposited: false,
            receivedAt: Date.now(),
          },
        }
      }
      if (
        typeof notice.status === 'string' &&
        !(view.status === 'restoreFailed' && ['completed', 'failed'].includes(notice.status))
      )
        view = { ...view, status: notice.status }
      if (typeof notice.app === 'string') view = { ...view, app: notice.app }
      update(session, { ...view, updatedAt: Date.now() })
    },
    async control(command: AutomationPreviewCommand) {
      const session = sessionFor(command)
      // 未有窗口时记录订阅意图，不为看一个空面板启动助手。
      const key = previewOwnerKey(command)
      if (command.action === 'show') watching.add(key)
      if (command.action === 'hide') watching.delete(key)
      const client = helper.connected
      if (!session || !client) return
      if (command.action === 'show') {
        const view = views.get(session)
        if (view) publish(view, view.owner)
      }
      const methods = {
        show: 'previewSubscribe',
        hide: 'previewHide',
        stop: 'stopSession',
        takeover: 'takeover',
        ack: 'previewAck',
        pin: 'previewPin',
        unpin: 'previewUnpin',
      } as const
      const view = views.get(session)
      if (
        command.action === 'ack' &&
        (!view?.frame || view.frame.streamId !== command.streamId || view.frame.seq !== command.seq)
      )
        return
      await client.request(
        methods[command.action],
        {
          session,
          ...(command.streamId ? { streamId: command.streamId, seq: command.seq } : {}),
        },
        5000,
      )
    },
    disconnected(clearSubscriptions = false) {
      for (const view of views.values()) publish(null, view.owner)
      views.clear()
      owners.clear()
      if (clearSubscriptions) watching.clear()
    },
  }
}
