// 只读核心已有的设备/侧栏副本；订阅不会发出 RPC，也不另设远程轮询。
import { createHash, randomUUID } from 'node:crypto'
import type {
  AppOp,
  AppView,
  CoreHost,
  DeviceView,
  SessionSummary,
  SidebarOp,
  SidebarView,
} from '@litch/core'

interface Evidence {
  device: string
  harness: string
  working: number
  observed: number
  unknown: boolean
}
export interface RemotePowerReport {
  generation: string
  sequence: number
  complete: boolean
  sources: { id: string; working: number; observedAgoMs: number; unknown: boolean }[]
}

export class RemotePowerActivity {
  private readonly generation = randomUUID()
  private sequence = 0
  private readonly devices = new Map<string, DeviceView>()
  private readonly rows = new Map<string, Map<string, SessionSummary>>()
  private readonly archived = new Map<string, Map<string, SessionSummary>>()
  private readonly fresh = new Set<string>()
  private readonly evidence = new Map<string, Evidence>()

  private readonly now: () => number

  constructor(now: () => number = () => performance.now()) {
    this.now = now
  }

  device(value: DeviceView): void {
    if (value.kind !== 'ssh') return
    const previous = this.devices.get(value.id)
    this.devices.set(value.id, value)
    // 重连先等目录对账。online 通知先于侧栏快照，不能替断线前的缓存续期。
    if (value.connection !== 'online' || previous?.connection !== 'online' || value.stale)
      this.fresh.delete(value.id)
  }

  remove(deviceId: string): void {
    this.devices.delete(deviceId)
    this.rows.delete(deviceId)
    this.archived.delete(deviceId)
    this.fresh.delete(deviceId)
    for (const [key, value] of this.evidence)
      if (value.device === deviceId) this.evidence.delete(key)
  }

  sidebar(deviceId: string, value: SidebarView): void {
    this.rows.set(deviceId, new Map(value.sessions.map((row) => [row.id, row])))
    this.archived.set(deviceId, new Map((value.archived ?? []).map((row) => [row.id, row])))
    if (this.devices.get(deviceId)?.connection === 'online') this.fresh.add(deviceId)
  }

  delta(deviceId: string, ops: SidebarOp[]): void {
    const rows = this.rows.get(deviceId)
    if (!rows) return
    for (const op of ops) {
      if (op.op === 'session.upsert') rows.set(op.session.id, op.session)
      else if (op.op === 'session.remove') rows.delete(op.sessionId)
      else if (op.op === 'archived.set') {
        // 已归档表重新取回的活动也参与；归档本身不代表任务结束。
        this.archived.set(deviceId, new Map((op.sessions ?? []).map((row) => [row.id, row])))
      }
    }
  }

  snapshot(): RemotePowerReport {
    const now = this.now()
    const next = new Map<string, Evidence>()
    for (const [deviceId, device] of this.devices) {
      const online =
        device.connection === 'online' &&
        !device.stale &&
        device.note === null &&
        this.fresh.has(deviceId)
      const ready = (harness: string) =>
        online && device.harnesses.some((entry) => entry.id === harness && entry.state === 'ready')
      // 失联的设备或 harness 沿用上次证据的原始时间，不随心跳或别台设备的进展续期。
      for (const [id, old] of this.evidence)
        if (old.device === deviceId && !ready(old.harness)) next.set(id, { ...old, unknown: true })
      const rows = new Map([
        ...(this.archived.get(deviceId) ?? []),
        ...(this.rows.get(deviceId) ?? []),
      ])
      for (const row of rows.values()) {
        if (!ready(row.harness)) continue
        for (const [kind, working] of [
          ['turn', row.status === 'running' || row.status === 'waiting' ? 1 : 0],
          ['background', row.background?.running ? 1 : 0],
        ] as const) {
          if (!working) continue
          const id = createHash('sha256')
            .update(JSON.stringify([deviceId, row.harness, row.id, kind]))
            .digest('hex')
          next.set(id, {
            device: deviceId,
            harness: row.harness,
            working,
            observed: now,
            unknown: false,
          })
        }
      }
    }
    this.evidence.clear()
    for (const [id, evidence] of next) this.evidence.set(id, evidence)
    return {
      generation: this.generation,
      sequence: ++this.sequence,
      complete: true,
      sources: [...next].map(([id, value]) => ({
        id,
        working: value.working,
        observedAgoMs: Math.ceil(Math.max(0, now - value.observed)),
        unknown: value.unknown,
      })),
    }
  }
}

/** 应用自己的订阅保持完整设备目录；不依赖界面当前展开的是哪一台设备或哪一条工作线。 */
export function watchRemotePower(
  core: CoreHost,
  activity: RemotePowerActivity,
  changed: () => void,
): () => void {
  const stops = new Map<string, () => void>()
  const upsert = (device: DeviceView) => {
    if (device.kind !== 'ssh') return
    activity.device(device)
    if (stops.has(device.id)) return
    stops.set(
      device.id,
      core.subscribe(
        { kind: 'sidebar', deviceId: device.id },
        {
          snapshot(data) {
            activity.sidebar(device.id, data as SidebarView)
            changed()
          },
          delta(ops) {
            activity.delta(device.id, ops as SidebarOp[])
            changed()
          },
          error() {
            activity.device({ ...device, connection: 'offline' })
            changed()
          },
        },
      ),
    )
  }
  const remove = (id: string) => {
    stops.get(id)?.()
    stops.delete(id)
    activity.remove(id)
  }
  const stopApp = core.subscribe(
    { kind: 'app' },
    {
      snapshot(data) {
        const devices = (data as AppView).devices
        for (const id of stops.keys()) if (!devices.some((device) => device.id === id)) remove(id)
        for (const device of devices) upsert(device)
        changed()
      },
      delta(ops) {
        for (const op of ops as AppOp[]) {
          if (op.op === 'device.upsert') upsert(op.device)
          else remove(op.deviceId)
        }
        changed()
      },
      error() {
        for (const id of stops.keys()) remove(id)
        changed()
      },
    },
  )
  return () => {
    stopApp()
    for (const stop of stops.values()) stop()
    stops.clear()
  }
}
