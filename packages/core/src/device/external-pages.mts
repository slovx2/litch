// 有人看才取快照。刷新重新以第一条游标串起来，避免新页插到旧游标留下重项或空洞。
import type { ExternalPage } from '../../../protocol/src/external-sources.mjs'
import { ChannelError, type ChannelErrorShape } from '../channel/protocol.mjs'
import type { HostSink } from '../channel/server.mjs'
import type { ExternalSnapshot } from '../projection/external.mjs'

export interface ExternalReadHost {
  online(): boolean
  now(): number
  fail(error: unknown): ChannelError
}

const PAGE_LIMIT = 30

export class ExternalRead<T> {
  readonly sinks = new Set<HostSink>()
  value: T | null = null
  fetchedAt: number | null = null
  error: ChannelErrorShape | null = null
  private epoch = 0
  private latest: Promise<void> | null = null
  private dirty = false
  private readonly host: ExternalReadHost
  readonly available: () => boolean
  private readonly read: () => Promise<T | null>
  private readonly publish: () => void

  constructor(
    host: ExternalReadHost,
    available: () => boolean,
    read: () => Promise<T | null>,
    publish: () => void,
  ) {
    this.host = host
    this.available = available
    this.read = read
    this.publish = publish
  }

  snapshot(): ExternalSnapshot<T> {
    const available = this.available()
    return {
      available,
      online: this.host.online(),
      value: available ? this.value : null,
      fetchedAt: available ? this.fetchedAt : null,
      error: this.error,
    }
  }

  open(sink: HostSink): () => void {
    const first = this.sinks.size === 0
    this.sinks.add(sink)
    sink.snapshot(this.snapshot())
    if (first) void this.refresh()
    return () => {
      this.sinks.delete(sink)
    }
  }

  notify(): void {
    if (this.sinks.size > 0) this.refresh()
  }

  connectionChanged(): void {
    this.epoch++
    this.latest = null
    this.dirty = false
    this.error = null
    if (this.host.online() && !this.available()) {
      this.value = null
      this.fetchedAt = null
    }
    this.publish()
  }

  refresh(): Promise<void> {
    if (!this.host.online() || !this.available()) return Promise.resolve()
    if (this.latest) {
      this.dirty = true
      return this.latest
    }
    const epoch = this.epoch
    const sync = async () => {
      do {
        this.dirty = false
        try {
          const result = await this.read()
          if (epoch !== this.epoch) return
          if (this.dirty) continue
          this.value = result
          this.fetchedAt = this.host.now()
          this.error = null
        } catch (error) {
          if (epoch !== this.epoch) return
          if (this.dirty) continue
          const failure = this.host.fail(error)
          this.error = failure.toShape()
          // 权限缩小时，不能用上一条连接的结果填补当前读不到的数据。
          if (failure.code === 'rejected' || failure.code === 'unsupported') {
            this.value = null
            this.fetchedAt = null
          }
        }
        this.publish()
      } while (this.dirty && epoch === this.epoch)
    }
    this.latest = sync().finally(() => {
      if (epoch === this.epoch) this.latest = null
    })
    return this.latest
  }

  send(): void {
    const value = this.snapshot()
    for (const sink of this.sinks) sink.snapshot(value)
  }
}

export class ExternalPages<T extends { seq: number }> {
  readonly read: ExternalRead<ExternalPage<T>>
  private pages = 1
  private readonly page: (query: { beforeSeq?: number; limit: number }) => Promise<ExternalPage<T>>

  constructor(
    host: ExternalReadHost,
    available: () => boolean,
    page: (query: { beforeSeq?: number; limit: number }) => Promise<ExternalPage<T>>,
  ) {
    this.page = page
    this.read = new ExternalRead(
      host,
      available,
      () => this.load(),
      () => this.read.send(),
    )
  }

  async more(): Promise<void> {
    if (this.read.value?.nextBeforeSeq == null) return
    this.pages++
    await this.read.refresh()
    const error = this.read.error
    if (error) {
      this.pages--
      throw new ChannelError(error.code, error.message)
    }
  }

  private async load(): Promise<ExternalPage<T>> {
    const entries = new Map<number, T>()
    let nextBeforeSeq: number | null = null
    for (let i = 0; i < this.pages; i++) {
      const page = await this.page({
        limit: PAGE_LIMIT,
        ...(nextBeforeSeq === null ? {} : { beforeSeq: nextBeforeSeq }),
      })
      for (const entry of page.entries) entries.set(entry.seq, entry)
      if (
        page.nextBeforeSeq !== null &&
        nextBeforeSeq !== null &&
        page.nextBeforeSeq >= nextBeforeSeq
      )
        throw new ChannelError('remote', 'Invalid external page cursor')
      nextBeforeSeq = page.nextBeforeSeq
      if (nextBeforeSeq === null) break
    }
    return { entries: [...entries.values()], nextBeforeSeq }
  }
}
