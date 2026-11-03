// 分页缓存仅保存看过的列表和详情；后台对账重建这些页，不补拉未打开的状态。
import type {
  ManagerBoard,
  ManagerDecision,
  ManagerObjectId,
} from '../../../protocol/src/manager.mjs'
import {
  type ManagerBoardSummary,
  type ManagerObjectDetail,
  type ManagerObjectPage,
  type ManagerPageQuery,
  MANAGER_PAGING_METHOD as METHOD,
} from '../../../protocol/src/manager-paging.mjs'
import type { ManagerBoardTopicView, ManagerPagingView } from '../model-manager.mjs'
import { projectManager, projectManagerBoard } from '../projection/manager.mjs'
import { managerPageKey } from '../projection/manager-paging.mjs'
import type { ManagersHost } from './manager.mjs'

const timed = <T extends { at: number }>(value: T): T => ({ ...value, at: value.at * 1000 })
const projectPage = (page: ManagerObjectPage): ManagerObjectPage => ({
  ...page,
  entries: page.entries.map((head) => ({
    ...head,
    createdAt: head.createdAt * 1000,
    updatedAt: head.updatedAt * 1000,
  })),
})
const projectLines = (lines: ManagerBoardSummary['lines']) => ({
  ...lines,
  checkedAt: lines.checkedAt === null ? null : lines.checkedAt * 1000,
  lines: lines.lines.map((line) => ({
    ...line,
    startedAt: line.startedAt === null ? null : line.startedAt * 1000,
    checkedAt: line.checkedAt === null ? null : line.checkedAt * 1000,
  })),
})

export class PagedManagerBoard {
  readonly host: ManagersHost
  readonly managerId: string
  readonly publish: (value: Pick<ManagerBoardTopicView, 'board' | 'paging'>) => void
  private summary: ManagerBoardSummary | null = null
  private pages = new Map<string, ManagerObjectPage>()
  private details = new Map<ManagerObjectId, ManagerObjectDetail>()
  private histories: ManagerPagingView['histories'] = {}
  private busy = new Map<string, Promise<void>>()
  private counts = new Map<string, number>()
  private error: string | null = null
  private stopped = false
  private serial: Promise<void> = Promise.resolve()
  private mutation = 0
  constructor(host: ManagersHost, managerId: string, publish: PagedManagerBoard['publish']) {
    this.host = host
    this.managerId = managerId
    this.publish = publish
  }
  stop() {
    this.stopped = true
  }
  private emit() {
    if (!this.summary || this.stopped) return
    const summary = this.summary
    const board: ManagerBoard & Required<Pick<ManagerBoard, 'requests' | 'posts' | 'relations'>> = {
      managerId: this.managerId,
      situation: summary.situation,
      decisions: [],
      items: [],
      requests: [],
      posts: [],
      relations: [],
      changes: [],
      activities: summary.activities,
      lines: summary.lines.lines.map(
        ({ reportPreview: _report, unverifiedCount: _count, checkedAt: _checked, ...line }) => ({
          ...line,
          report: null,
          unverified: [],
        }),
      ),
    }
    for (const detail of this.details.values()) {
      if (detail.object?.id.startsWith('D-')) board.decisions.push(detail.object as ManagerDecision)
      if (detail.object?.id.startsWith('I-'))
        board.items.push(detail.object as ManagerBoard['items'][number])
      if (detail.object?.id.startsWith('R-'))
        board.requests.push(detail.object as NonNullable<ManagerBoard['requests']>[number])
      if (detail.post) board.posts.push(detail.post)
      for (const relation of detail.relations)
        if (!board.relations.some((r) => r.id === relation.id)) board.relations.push(relation)
    }
    const projected = projectManagerBoard(this.host.deviceId, board)
    for (const decision of projected.decisions) {
      const detail = this.details.get(decision.id)
      decision.previousClosed = detail?.previousClosed ? timed(detail.previousClosed) : null
      decision.reopened = detail?.reopened ? timed(detail.reopened) : null
    }
    this.publish({
      board: projected,
      paging: {
        summary: {
          ...summary,
          manager: projectManager(this.host.deviceId, summary.manager),
          situation: summary.situation ? timed(summary.situation) : null,
          activities: summary.activities.map(timed),
          initial: projectPage(summary.initial),
          lines: projectLines(summary.lines),
        },
        pages: Object.fromEntries([...this.pages].map(([key, page]) => [key, projectPage(page)])),
        histories: Object.fromEntries(
          Object.entries(this.histories).map(([id, page]) => [
            id,
            { ...page, changes: page.changes.map(timed) },
          ]),
        ),
        loading: [...this.busy.keys()],
        error: this.error,
      },
    })
  }
  private run(key: string, task: () => Promise<void>): Promise<void> {
    const pending = this.busy.get(key)
    if (pending) return pending
    const promise = (key === 'lines' ? Promise.resolve() : this.serial)
      .then(() => (this.stopped ? undefined : task()))
      .catch((error) => {
        this.error = String(error)
        throw error
      })
      .finally(() => {
        this.busy.delete(key)
        this.emit()
      })
    this.busy.set(key, promise)
    this.error = null
    this.emit()
    if (key !== 'lines') this.serial = promise.catch(() => {})
    return promise
  }
  async refresh() {
    return this.run('summary', async () => {
      let revision: number
      do {
        revision = this.mutation
        const { summary } = await this.host.request(METHOD.summary, { managerId: this.managerId })
        const initialKey = managerPageKey(summary.initial.query)
        const nextPages = new Map(this.pages)
        if (!this.pages.has(initialKey)) {
          this.pages.set(initialKey, summary.initial)
          this.counts.set(initialKey, 1)
        }
        // 首屏先发布，详情对账和工作线核对不挡住摘要。
        if (!this.summary) {
          this.summary = summary
          this.emit()
        }
        await Promise.all(
          [...this.pages].map(async ([key, old]) => {
            let page =
              key === initialKey
                ? summary.initial
                : await this.host.request(METHOD.page, { managerId: this.managerId, ...old.query })
            for (let i = 1; i < (this.counts.get(key) ?? 1) && page.nextCursor; i++) {
              const next = await this.host.request(METHOD.page, {
                managerId: this.managerId,
                ...old.query,
                cursor: page.nextCursor,
              })
              page = { ...next, entries: [...page.entries, ...next.entries] }
            }
            nextPages.set(key, page)
          }),
        )
        await Promise.all([...this.details.keys()].map((id) => this.fetchDetail(id)))
        await Promise.all(
          Object.keys(this.histories).map((id) =>
            this.fetchHistory(id as ManagerObjectId, false, true),
          ),
        )
        if (revision === this.mutation) {
          this.summary = summary
          this.pages = nextPages
        }
      } while (revision !== this.mutation && !this.stopped)
    })
  }
  async page(query: ManagerPageQuery, more = false) {
    const key = managerPageKey(query)
    return this.run(key, async () => {
      const previous = this.pages.get(key)
      if (previous && !more) return
      if (more && previous && !previous.nextCursor) return
      const page = await this.host.request(METHOD.page, {
        managerId: this.managerId,
        ...query,
        ...(more && previous?.nextCursor ? { cursor: previous.nextCursor } : {}),
      })
      this.pages.set(
        key,
        more && previous
          ? {
              ...page,
              entries: [
                ...new Map(
                  [...previous.entries, ...page.entries].map((head) => [head.id, head]),
                ).values(),
              ],
            }
          : page,
      )
      this.counts.set(key, more ? (this.counts.get(key) ?? 0) + 1 : 1)
    })
  }
  private async fetchDetail(id: ManagerObjectId) {
    const detail = await this.host.request(METHOD.detail, { managerId: this.managerId, id })
    const old = this.details.get(id)
    if ((old?.object?.revision ?? 0) > (detail.object?.revision ?? 0)) return
    this.details.set(id, detail)
  }
  detail(id: ManagerObjectId) {
    return this.run(id, () => this.fetchDetail(id))
  }
  private async fetchHistory(id: ManagerObjectId, more = false, refresh = false) {
    const previous = this.histories[id]
    if (previous && !more && !refresh) return
    if (previous && more && !previous.nextCursor) return
    let page = await this.host.request(METHOD.history, {
      managerId: this.managerId,
      id,
      ...(more && previous?.nextCursor ? { cursor: previous.nextCursor } : {}),
    })
    if (refresh)
      while (page.nextCursor && page.changes.length < (previous?.changes.length ?? 0)) {
        const next = await this.host.request(METHOD.history, {
          managerId: this.managerId,
          id,
          cursor: page.nextCursor,
        })
        page = { ...next, changes: [...page.changes, ...next.changes] }
      }
    this.histories[id] =
      more && previous ? { ...page, changes: [...previous.changes, ...page.changes] } : page
  }
  history(id: ManagerObjectId, more = false) {
    return this.run(`history:${id}`, () => this.fetchHistory(id, more))
  }
  lines() {
    return this.run('lines', async () => {
      const lines = await this.host.request(METHOD.lines, {
        managerId: this.managerId,
        refresh: true,
      })
      if (this.summary) this.summary = { ...this.summary, lines }
    })
  }
  accepted(decisions: ManagerDecision[]) {
    if (!this.summary) return
    this.mutation++
    for (const decision of decisions) {
      const detail = this.details.get(decision.id)
      const before = detail?.object
      if (!before || before.revision >= decision.revision) continue
      if (!detail) continue
      this.details.set(decision.id, {
        ...detail,
        object: decision,
        post: detail.post
          ? {
              ...detail.post,
              revision: decision.revision,
              updatedAt: decision.updatedAt,
              fields: { ...detail.post.fields, status: decision.status },
            }
          : null,
      })
      const counts = this.summary.counts.decision
      counts[before.status] = Math.max(0, (counts[before.status] ?? 0) - 1)
      counts[decision.status] = (counts[decision.status] ?? 0) + 1
      counts.pending = counts.open ?? 0
      counts.closed = (counts.expired ?? 0) + (counts.withdrawn ?? 0)
      for (const [key, page] of this.pages) {
        if (page.query.kind !== 'decision') continue
        const matches =
          page.query.status === 'all' ||
          page.query.status === decision.status ||
          (page.query.status === 'pending' && decision.status === 'open') ||
          (page.query.status === 'closed' && ['expired', 'withdrawn'].includes(decision.status))
        this.pages.set(key, {
          ...page,
          total: this.summary.counts.decision[page.query.status] ?? 0,
          entries: page.entries.flatMap((head) =>
            head.id !== decision.id
              ? [head]
              : matches
                ? [
                    {
                      ...head,
                      status: decision.status,
                      pending: decision.status === 'open',
                      revision: decision.revision,
                      updatedAt: decision.updatedAt,
                    },
                  ]
                : [],
          ),
        })
      }
    }
    this.emit()
  }
}
