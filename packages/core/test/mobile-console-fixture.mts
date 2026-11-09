// 手机控制台隔离验收：模拟远程先到经理、后到分页看板；保留正式模拟核心的 issue 查询。
import type { CoreHost } from '../src/channel/server.mjs'
import { sampleManagers } from '../src/mock/sample-manager.mjs'

export function managerBoardFixture(mock: CoreHost) {
  const samples = sampleManagers('local', Date.now(), 'zh-CN')
  const sinks = new Map<any, any>()
  const state = {
    mode: 'normal',
    change(mode: string) {
      state.mode = mode
      for (const [sink, view] of sinks) sink.snapshot(project(view))
    },
  }
  const project = (view: any) => {
    if (!view.board) return view
    const manager = samples.managers.find((one) => one.id === view.managerId) ?? samples.managers[0]
    const board = view.board
    const issues = structuredClone(view.issues)
    if (issues) {
      if (state.mode === 'loading') issues.pages = {}
      if (state.mode === 'error') issues.error = '隔离验收：列表读取失败'
      if (state.mode === 'empty')
        for (const page of Object.values(issues.pages) as any[]) {
          page.entries = []
          page.total = 0
          page.nextCursor = null
        }
    }
    return {
      ...view,
      ...(state.mode === 'board-error' ? { loadError: '隔离验收：看板读取失败' } : {}),
      issues,
      features: { ...view.features, paging: true },
      paging: {
        summary: {
          manager,
          situation: board.situation,
          counts: {
            decision: { open: 2 },
            request: { open: 1 },
            suggestion: {},
            report: {},
            item: {},
          },
          activities: [],
          lines: { lines: [], checkedAt: null, failed: 0 },
        },
        pages: {},
        histories: {},
        loading: [],
        error: null,
      },
    }
  }
  return {
    state,
    core: {
      ...mock,
      subscribe(topic: any, sink: any) {
        if (topic.kind !== 'managerBoard') return mock.subscribe(topic, sink)
        let timer: ReturnType<typeof setTimeout> | undefined
        let ready = false
        const receive = (view: any) => {
          sinks.set(sink, view)
          if (ready) sink.snapshot(project(view))
          else if (!timer) {
            sink.snapshot({ ...view, board: null, issues: undefined, paging: undefined })
            timer = setTimeout(() => {
              ready = true
              sink.snapshot(project(sinks.get(sink)))
            }, 200)
          }
        }
        const off = mock.subscribe(topic, {
          ...sink,
          snapshot: receive,
          delta: (patches: any[]) => {
            const latest = patches.find((patch) => patch.op === 'managerBoard.set')
            if (latest) receive(latest.view)
          },
        })
        return () => {
          clearTimeout(timer)
          sinks.delete(sink)
          off()
        }
      },
    } as CoreHost,
  }
}
