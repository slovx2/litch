// 控制端内存投影。连续帧不进设备协议、会话历史或日志；订阅关闭就撤下对应媒体消费者。
import { ChannelError } from '../channel/protocol.mjs'
import type { CoreHost, HostSink } from '../channel/server.mjs'
import {
  type AutomationPreviewCommand,
  type AutomationPreviewPort,
  type AutomationPreviewView,
  previewOwnerKey,
} from './model.mjs'

export function withAutomationPreview<T extends CoreHost>(core: T, port: AutomationPreviewPort): T {
  const views = new Map<string, AutomationPreviewView>()
  const sinks = new Map<string, Set<HostSink>>()
  const observers = new Map<string, Set<HostSink>>()
  port.listen((view, owner) => {
    const key = previewOwnerKey(owner)
    if (view) views.set(key, view)
    else views.delete(key)
    for (const sink of sinks.get(key) ?? []) sink.snapshot(view)
    for (const sink of observers.get(key) ?? [])
      sink.snapshot(view ? { ...view, frame: null } : null)
  })
  return {
    ...core,
    async command(name, params, signal) {
      if (name !== 'automationPreview.control') return core.command(name, params, signal)
      const value = params as AutomationPreviewCommand
      if (
        !value ||
        typeof value.deviceId !== 'string' ||
        typeof value.sessionId !== 'string' ||
        !['show', 'hide', 'stop', 'takeover', 'ack', 'pin', 'unpin'].includes(value.action)
      ) {
        throw new ChannelError('invalid', 'Invalid preview command')
      }
      if (signal.aborted) throw new ChannelError('cancelled', 'Cancelled')
      await port.command(value)
      return {}
    },
    subscribe(topic, sink) {
      if (topic.kind !== 'automationPreview') return core.subscribe(topic, sink)
      const owner = { deviceId: topic.deviceId, sessionId: topic.sessionId }
      const key = previewOwnerKey(owner)
      const pool = topic.observeOnly ? observers : sinks
      const group = pool.get(key) ?? new Set<HostSink>()
      pool.set(key, group)
      group.add(sink)
      const view = views.get(key)
      sink.snapshot(view && topic.observeOnly ? { ...view, frame: null } : (view ?? null))
      if (!topic.observeOnly) void port.command({ ...owner, action: 'show' }).catch(() => {})
      return () => {
        group.delete(sink)
        if (!group.size) {
          pool.delete(key)
          if (!topic.observeOnly) {
            void port.command({ ...owner, action: 'hide' }).catch(() => {})
            const view = views.get(key)
            if (view) views.set(key, { ...view, frame: null })
          }
          if (!sinks.has(key) && !observers.has(key)) views.delete(key)
        }
      }
    },
  }
}
