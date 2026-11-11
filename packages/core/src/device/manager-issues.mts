import {
  type ManagerIssueQuery,
  type ManagerIssueRef,
  type ManagerIssueRequests,
  MANAGER_ISSUE_METHOD as METHOD,
} from '../../../protocol/src/manager-issues.mjs'
import type { ManagerIssuesView } from '../model-manager-issues.mjs'
import { managerIssueQueryKey } from '../model-manager-issues.mjs'
import {
  projectManagerIssue,
  projectManagerIssuePage,
} from '../projection/manager-public-issues.mjs'
import type { ManagersHost } from './manager.mjs'

export interface ManagerIssueCallOptions {
  manual?: boolean
}

// 在途请求按代际丢弃；通知时重读所有已订阅页面和详情，断线保留最后快照。
export class ManagerIssueCache {
  readonly host: ManagersHost
  readonly managerId: string
  readonly publish: (view: ManagerIssuesView) => void
  private epoch = 0
  private queries = new Map<string, ManagerIssueQuery>()
  private refs = new Set<ManagerIssueRef>()
  private pending = new Map<string, Promise<unknown>>()
  private failed = new Map<string, { at: number; error: unknown }>()
  private refreshing: Promise<void> | null = null
  private cancelRefresh: (() => void) | null = null
  private dirty = false
  private view: ManagerIssuesView = { pages: {}, details: {}, loading: [], error: null }
  constructor(host: ManagersHost, managerId: string, publish: (view: ManagerIssuesView) => void) {
    this.host = host
    this.managerId = managerId
    this.publish = publish
  }
  stop() {
    this.epoch++
    this.cancelRefresh?.()
    this.cancelRefresh = null
    this.pending.clear()
    this.failed.clear()
    this.refreshing = null
    this.dirty = false
    this.view = { ...this.view, loading: [] }
  }
  refresh(options: ManagerIssueCallOptions = {}): Promise<void> {
    if (options.manual) return this.refreshOnce(this.epoch, options)
    this.dirty = true
    if (this.refreshing) return this.refreshing
    const mine = this.epoch
    const run = Promise.resolve().then(async () => {
      while (this.dirty && mine === this.epoch && this.host.online()) {
        // 固定窗口合并跨帧通知；持续收到通知也不延长窗口，读取期间至多积一轮补读。
        await new Promise<void>((resolve) => {
          const cancel = this.host.clock.setTimer(resolve, 50)
          this.cancelRefresh = () => {
            cancel()
            resolve()
          }
        })
        if (mine !== this.epoch) return
        this.cancelRefresh = null
        this.dirty = false
        await this.refreshOnce(mine)
      }
    })
    this.refreshing = run
    void run
      .finally(() => {
        if (this.refreshing === run) this.refreshing = null
      })
      .catch(() => {})
    return run
  }
  private async refreshOnce(mine: number, options: ManagerIssueCallOptions = {}) {
    // 首页替换、后页追加必须有确定顺序；不能让迟到的首页清掉已加载的后页。
    for (const query of [...this.queries.values()].sort(
      (a, b) => Number(a.cursor ?? 0) - Number(b.cursor ?? 0),
    )) {
      if (mine !== this.epoch || !this.host.online()) return
      await this.call(METHOD.list, query, options)
    }
    if (mine !== this.epoch || !this.host.online()) return
    await Promise.all(
      [...this.refs].map((id) =>
        this.call(METHOD.read, { managerId: this.managerId, id }, options),
      ),
    )
  }
  call<M extends keyof ManagerIssueRequests>(
    method: M,
    params: ManagerIssueRequests[M]['params'],
    options: ManagerIssueCallOptions = {},
  ): Promise<ManagerIssueRequests[M]['result']> {
    // 先登记再发布 loading；订阅者重入也只能共享一条请求。写入只合并幂等的 seen。
    const merge = method === METHOD.list || method === METHOD.read || method === METHOD.seen
    const key =
      method === METHOD.list
        ? `${method}:${managerIssueQueryKey(params as ManagerIssueQuery)}:${(params as ManagerIssueQuery).cursor ?? ''}`
        : `${method}:${JSON.stringify(params)}`
    const failed = merge ? this.failed.get(key) : undefined
    // 手动重试绕过冷却；成功前仍保留自动重读的冷却，防止同时到来的通知重新放大请求。
    if (!options.manual && failed && Date.now() - failed.at < 30_000)
      return Promise.reject(failed.error)
    const pending = merge ? this.pending.get(key) : undefined
    if (pending) return pending as Promise<ManagerIssueRequests[M]['result']>
    const mine = this.epoch
    const run = Promise.resolve().then(() => this.request(method, params, mine))
    if (merge) {
      this.pending.set(key, run)
      void run.then(
        () => {
          if (this.pending.get(key) === run) this.pending.delete(key)
          if (mine === this.epoch) this.failed.delete(key)
        },
        (error) => {
          if (this.pending.get(key) === run) this.pending.delete(key)
          if (mine !== this.epoch) return
          this.failed.set(key, { at: Date.now(), error })
          if (this.failed.size > 256) this.failed.delete(this.failed.keys().next().value!)
        },
      )
    }
    return run
  }
  private async request<M extends keyof ManagerIssueRequests>(
    method: M,
    params: ManagerIssueRequests[M]['params'],
    mine: number,
  ): Promise<ManagerIssueRequests[M]['result']> {
    if (mine !== this.epoch) throw new Error('Issue cache stopped')
    if (method === METHOD.list) {
      const query = params as ManagerIssueQuery
      this.queries.set(`${managerIssueQueryKey(query)}:${query.cursor ?? ''}`, query)
    } else if (method === METHOD.read && 'id' in params) this.refs.add(params.id)
    const token = `${method}:${'id' in params ? params.id : ''}`
    this.view = { ...this.view, loading: [...new Set([...this.view.loading, token])], error: null }
    this.publish(this.view)
    let result: ManagerIssueRequests[M]['result']
    try {
      // 每次发送（包括重连后的缓存刷新）都按当前能力裁剪，不能只在 UI 隐藏入口。
      if (!this.host.features().issueDiscussions && method === METHOD.list) {
        const { discussionsOnly, ...query } = params as ManagerIssueQuery
        const reply = await this.host.request(METHOD.list, {
          ...query,
          ...(discussionsOnly ? { kinds: ['ordinary'] } : {}),
        })
        // 用调用方原查询缓存结果，防止降级后页面一直等不到原来的页键。
        result = {
          page: { ...reply.page, query: params as ManagerIssueQuery },
        } as ManagerIssueRequests[M]['result']
      } else if (
        !this.host.features().issueDiscussions &&
        method === METHOD.update &&
        'patch' in params &&
        'discussionOpened' in params.patch
      ) {
        const { discussionOpened: _opened, ...patch } = params.patch
        result = (
          Object.keys(patch).length
            ? await this.host.request(METHOD.update, { ...params, patch })
            : await this.host.request(METHOD.read, { managerId: params.managerId, id: params.id })
        ) as ManagerIssueRequests[M]['result']
      } else result = await this.host.request(method, params)
    } catch (error) {
      if (mine === this.epoch) {
        this.view = { ...this.view, error: String(error) }
        this.publish(this.view)
      }
      throw error
    } finally {
      if (mine === this.epoch) {
        this.view = { ...this.view, loading: this.view.loading.filter((key) => key !== token) }
        this.publish(this.view)
      }
    }
    if ('page' in result) {
      const page = projectManagerIssuePage(result.page)
      if (mine !== this.epoch) return { page } as ManagerIssueRequests[M]['result']
      const key = managerIssueQueryKey(page.query)
      this.queries.set(`${key}:${page.query.cursor ?? ''}`, page.query)
      const previous = this.view.pages[key]
      const loaded =
        page.query.cursor && previous
          ? {
              ...page,
              entries: [
                ...previous.entries.filter((i) => !page.entries.some((next) => next.id === i.id)),
                ...page.entries,
              ],
            }
          : page
      this.view = { ...this.view, pages: { ...this.view.pages, [key]: loaded } }
      this.publish(this.view)
      return { page } as ManagerIssueRequests[M]['result']
    }
    const issue = projectManagerIssue(result.issue)
    if (mine !== this.epoch) {
      if (method !== METHOD.read && method !== METHOD.seen) {
        this.refs.add(issue.id)
        void this.refresh().catch((error) => this.host.log(String(error)))
      }
      return { issue } as ManagerIssueRequests[M]['result']
    }
    this.refs.add(issue.id)
    this.view = { ...this.view, details: { ...this.view.details, [issue.id]: issue } }
    this.publish(this.view)
    if (method !== METHOD.read && method !== METHOD.seen)
      void this.refresh().catch((error) => this.host.log(String(error)))
    return { issue } as ManagerIssueRequests[M]['result']
  }
}
