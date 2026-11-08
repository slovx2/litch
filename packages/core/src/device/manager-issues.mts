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

// 在途请求按代际丢弃；通知时重读所有已订阅页面和详情，断线保留最后快照。
export class ManagerIssueCache {
  readonly host: ManagersHost
  readonly managerId: string
  readonly publish: (view: ManagerIssuesView) => void
  private epoch = 0
  private queries = new Map<string, ManagerIssueQuery>()
  private refs = new Set<ManagerIssueRef>()
  private view: ManagerIssuesView = { pages: {}, details: {}, loading: [], error: null }
  constructor(host: ManagersHost, managerId: string, publish: (view: ManagerIssuesView) => void) {
    this.host = host
    this.managerId = managerId
    this.publish = publish
  }
  stop() {
    this.epoch++
  }
  async refresh() {
    this.epoch++
    const mine = this.epoch
    // 首页替换、后页追加必须有确定顺序；不能让迟到的首页清掉已加载的后页。
    for (const query of [...this.queries.values()].sort(
      (a, b) => Number(a.cursor ?? 0) - Number(b.cursor ?? 0),
    )) {
      if (mine !== this.epoch || !this.host.online()) return
      await this.call(METHOD.list, query)
    }
    if (mine !== this.epoch || !this.host.online()) return
    await Promise.all(
      [...this.refs].map((id) => this.call(METHOD.read, { managerId: this.managerId, id })),
    )
  }
  async call<M extends keyof ManagerIssueRequests>(
    method: M,
    params: ManagerIssueRequests[M]['params'],
  ): Promise<ManagerIssueRequests[M]['result']> {
    const mine = this.epoch
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
      this.view = { ...this.view, loading: this.view.loading.filter((key) => key !== token) }
      this.publish(this.view)
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
      if (method !== METHOD.read) {
        this.refs.add(issue.id)
        void this.refresh().catch((error) => this.host.log(String(error)))
      }
      return { issue } as ManagerIssueRequests[M]['result']
    }
    this.refs.add(issue.id)
    this.view = { ...this.view, details: { ...this.view.details, [issue.id]: issue } }
    this.publish(this.view)
    if (method !== METHOD.read) void this.refresh().catch((error) => this.host.log(String(error)))
    return { issue } as ManagerIssueRequests[M]['result']
  }
}
