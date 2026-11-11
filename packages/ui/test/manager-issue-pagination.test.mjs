import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { build, transform } from 'esbuild'

// 执行两端真实控制台，只替换绘制、命令和 React 调度；手动投递分页回包，检查 effect 是否重发首屏。
const projection = await build({
  entryPoints: [
    new URL('../../core/src/projection/manager-issue-list.mts', import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
})
const list = await import(
  `data:text/javascript;base64,${Buffer.from(projection.outputFiles[0].text).toString('base64')}`
)
const memoryBundle = await build({
  entryPoints: [new URL('../../core/src/manager-board-memory.mts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
})
const boardMemory = await import(
  `data:text/javascript;base64,${Buffer.from(memoryBundle.outputFiles[0].text).toString('base64')}`
)
const groupsBundle = await build({
  entryPoints: [new URL('../src/manager/issues/filter-groups.ts', import.meta.url).pathname],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
})
const groups = await import(
  `data:text/javascript;base64,${Buffer.from(groupsBundle.outputFiles[0].text).toString('base64')}`
)
const sources = {
  desktop: new URL('../src/manager/issues/IssueConsole.tsx', import.meta.url),
  mobile: new URL(
    '../../../apps/mobile/src/screens/managers/issues/IssueConsole.tsx',
    import.meta.url,
  ),
}
// 筛选栏拆在单独的文件里：同样执行真实代码
const filterSources = {
  desktop: new URL('../src/manager/issues/IssueFilterBar.tsx', import.meta.url),
  mobile: new URL(
    '../../../apps/mobile/src/screens/managers/issues/IssueFilters.tsx',
    import.meta.url,
  ),
}
const compile = async (path) =>
  (
    await transform(readFileSync(path, 'utf8'), {
      loader: 'tsx',
      format: 'cjs',
      jsx: 'automatic',
    })
  ).code
const compiled = Object.fromEntries(
  await Promise.all(
    Object.entries(sources).map(async ([platform, path]) => [platform, await compile(path)]),
  ),
)
const compiledFilters = Object.fromEntries(
  await Promise.all(
    Object.entries(filterSources).map(async ([platform, path]) => [platform, await compile(path)]),
  ),
)

let fixtureSeq = 0
function fixture(platform) {
  let discussions = true
  let active = true
  let load = 'normal'
  const positions = []
  const slots = []
  let cursor = 0
  let effects = []
  const same = (a, b) =>
    a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const memo = (make, deps) => {
    const index = cursor++
    if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: make(), deps }
    return slots[index].value
  }
  const effect = (run, deps) => {
    const index = cursor++
    if (!slots[index] || !same(slots[index].deps, deps)) effects.push(run)
    slots[index] = { deps }
  }
  const react = {
    useMemo: memo,
    useCallback: (value, deps) => memo(() => value, deps),
    useRef: (value) => memo(() => ({ current: value }), []),
    useEffect: effect,
    useLayoutEffect: effect,
    useState: (initial) => {
      const index = cursor++
      slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }
      return [
        slots[index].value,
        (next) => {
          slots[index].value = typeof next === 'function' ? next(slots[index].value) : next
        },
      ]
    },
  }
  const requests = []
  const listOptions = []
  const filters = []
  const commands = {
    read: () => Promise.resolve(),
    list: (filter, options = {}) => {
      listOptions.push(structuredClone(options))
      filters.push(structuredClone(filter))
      requests.push({ kind: filter.kinds[0], cursor: options.cursor ?? null })
      return Promise.resolve()
    },
  }
  const t = (key) => key
  const jsx = (type, props) => ({ type, props })
  const modules = {
    react,
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-dom': { createPortal: (content) => content },
    'react-native': { StyleSheet: { create: (styles) => styles } },
    '@litch/core': { managerBoardPages: () => ({ decisions: [] }) },
  }
  const filterOutput = { exports: {} }
  function require(name) {
    if (modules[name]) return modules[name]
    if (name.endsWith('/filter-groups.ts')) return groups
    if (name === './IssueFilterBar.tsx' || name === './IssueFilters') return filterOutput.exports
    if (name.endsWith('/popover.ts'))
      return {
        usePopover: () => ({ open: false, setOpen() {}, root: {}, trigger: {}, pop: {} }),
      }
    if (name.endsWith('/manager-issue-list.mts')) return list
    if (name.endsWith('/manager-board-memory.mts')) return boardMemory
    if (name.endsWith('/appearance.ts') || name.endsWith('/i18n')) return { useT: () => t }
    if (name.endsWith('/theme'))
      return { useTheme: () => ({ c: {}, font: { size: {} }, radius: {} }) }
    if (name.endsWith('/discussion-pane.ts')) return { useDiscussionPane: () => null }
    if (name === './data.ts' || name === './data')
      return { useIssueCommands: () => commands, useIssueCounts: () => null }
    // 子组件只保留 JSX 节点，不运行无关绘制。
    return {}
  }
  runInNewContext(compiledFilters[platform], {
    module: filterOutput,
    exports: filterOutput.exports,
    require,
  })
  const output = { exports: {} }
  runInNewContext(compiled[platform], { module: output, require })
  const manager = { deviceId: 'fixture', id: `manager-${platform}-${++fixtureSeq}` }
  const renderConsole =
    platform === 'desktop' ? output.exports.IssueConsole : output.exports.useIssueConsole
  let kind = 'decision'
  let loaded = 30
  let preset = null
  let target = null
  let linkedIssue = null
  let offPage = false
  let details = {}
  let result
  let tree
  const nodes = (node) => {
    if (Array.isArray(node)) return node.flatMap(nodes)
    if (!node || typeof node !== 'object') return []
    return [node, ...nodes(node.props?.children)]
  }
  // 筛选栏的几个组件展开成真实节点（它们自己的 useState 也走上面的假调度）
  const FILTER_PARTS = new Set([
    'IssueFilterBar',
    'IssueFilterFields',
    'CompactFilters',
    'CheckOption',
    'ClearFilters',
    'IssueStatusRow',
    'IssueFilterDrawer',
    'Segmented',
    'CheckChip',
  ])
  const expand = (node) => {
    if (Array.isArray(node)) return node.flatMap(expand)
    if (!node || typeof node !== 'object') return []
    const inner =
      typeof node.type === 'function' && FILTER_PARTS.has(node.type.name)
        ? expand(node.type(node.props))
        : []
    return [node, ...expand(node.props?.children), ...expand(node.props?.footer), ...inner]
  }
  function render() {
    cursor = 0
    effects = []
    const pages = Object.fromEntries(
      ['decision', 'ordinary'].map((category) => [
        list.managerIssuePageKey(manager.id, list.managerIssueKindFilter(category)),
        {
          entries: Array.from({ length: loaded }, (_, i) => ({
            id: `${category}-${i}`,
            kind: category,
          })),
          total: 38,
          nextCursor: loaded === 30 ? '30' : null,
        },
      ]),
    )
    if (linkedIssue) {
      for (const filter of filters) {
        pages[list.managerIssuePageKey(manager.id, filter)] = {
          entries:
            !offPage &&
            filter.kinds.includes(linkedIssue.kind) &&
            (!filter.statuses.length || filter.statuses.includes(linkedIssue.status))
              ? [list.managerIssueHead(linkedIssue)]
              : [],
          total: 80,
          nextCursor: 'next',
        }
      }
    }
    const props = {
      manager,
      kind,
      view: { board: { decisions: [], changes: [] } },
      issues: {
        supported: true,
        discussions,
        pages:
          load === 'loading'
            ? {}
            : load === 'empty'
              ? Object.fromEntries(
                  Object.entries(pages).map(([key, value]) => [key, { ...value, entries: [] }]),
                )
              : pages,
        details,
        error: load === 'error' ? 'fixture failure' : null,
      },
      active,
      onQuery: (memory, ready) => positions.push({ memory, ready }),
      disabled: false,
      target,
      onKind: (value) => {
        kind = value
      },
      onLocated: () => {
        target = null
      },
      preset,
    }
    result = renderConsole(props)
    tree = platform === 'desktop' ? result : [result.header, result.body, result.overlays]
    for (const run of effects) run()
  }
  /** 筛选控件展开后的全部节点；手机先打开筛选抽屉 */
  function filterControl() {
    // 先重绘一次，让展开时的假 hook 位置和上次一致（细分的展开状态存在那里）
    render()
    if (platform === 'mobile') {
      nodes(tree)
        .find((node) => node.props?.testID === 'issue-filter-open')
        .props.onPress()
      render()
    }
    return expand(tree)
  }
  const tid = (node) => (typeof node.props?.testID === 'string' ? node.props.testID : '')
  const press = (node) => (node.props.onClick ?? node.props.onPress ?? node.props.onToggle)()
  const statusKey = (node) =>
    platform === 'desktop'
      ? node.props?.['data-issue-filter-status']
      : tid(node).match(/^issue-filter-status:(.+)$/)?.[1]
  return {
    requests,
    listOptions,
    filters,
    positions,
    setActive(value) {
      active = value
      render()
    },
    load(value) {
      load = value
      render()
    },
    has(id) {
      return expand(tree).some((node) => node.props?.testID === id)
    },
    render,
    link(issue, options = {}) {
      linkedIssue = issue
      offPage = options.offPage === true
      details = options.delayed ? {} : { [issue.id]: issue }
      if (platform === 'desktop') target = issue.id
      else result.open(issue.id)
      for (let i = 0; i < 4; i++) render()
    },
    deliverDetail() {
      details = { [linkedIssue.id]: linkedIssue }
      for (let i = 0; i < 4; i++) render()
    },
    changeStatus(status) {
      linkedIssue = { ...linkedIssue, status }
      details = { [linkedIssue.id]: linkedIssue }
      for (let i = 0; i < 4; i++) render()
    },
    visible(id) {
      return nodes(tree).some((node) =>
        platform === 'desktop'
          ? node.props?.head?.id === id
          : node.props?.testID === `issue-card:${id}`,
      )
    },
    close(id) {
      const node = nodes(tree).find((node) =>
        platform === 'desktop' ? node.props?.head?.id === id : node.props?.issueId === id,
      )
      assert.ok(node, '链接应已打开目标')
      ;(node.props.onToggle ?? node.props.onClose)()
      render()
    },
    pickKind(category) {
      if (platform === 'desktop') kind = category
      else
        nodes(tree)
          .find((node) => node.props?.testID === `issue-capsule:${category}`)
          .props.onPress()
      render()
    },
    statusChoices() {
      return filterControl().map(statusKey).filter(Boolean)
    },
    pickStatus(key) {
      const button = filterControl().find((node) => statusKey(node) === key)
      assert.ok(button, `缺少状态选项 ${key}`)
      press(button)
      render()
    },
    preset(patch) {
      preset = { patch, version: (preset?.version ?? 0) + 1 }
      kind = 'ordinary'
      render()
      render()
    },
    remount() {
      slots.length = 0
      render()
    },
    oldDevice() {
      discussions = false
      render()
    },
    typeChoices() {
      return filterControl().flatMap((node) => {
        const value =
          platform === 'desktop'
            ? node.props?.['data-issue-filter-kind']
            : tid(node).match(/^issue-filter-kind:(.+)$/)?.[1]
        return value ? [value] : []
      })
    },
    /** 点筛选里的一个控件：桌面按 data 属性、手机按 testID */
    tap(desktop, mobile) {
      const [key, value] = desktop
      const button = filterControl().find((node) =>
        platform === 'desktop' ? node.props?.[key] === value : tid(node) === mobile,
      )
      assert.ok(button, `缺少控件 ${platform === 'desktop' ? desktop.join('=') : mobile}`)
      press(button)
      render()
    },
    present(desktop, mobile) {
      const [key, value] = desktop
      return filterControl().some((node) =>
        platform === 'desktop' ? node.props?.[key] === value : tid(node) === mobile,
      )
    },
    pickDecision() {
      if (platform === 'desktop') kind = 'decision'
      else
        nodes(tree)
          .find((node) => node.props?.testID === 'issue-capsule:decision')
          .props.onPress()
      render()
    },
    toggleType(type) {
      const button = filterControl().find((node) =>
        platform === 'desktop'
          ? node.props?.['data-issue-filter-kind'] === type
          : node.props?.testID === `issue-filter-kind:${type}`,
      )
      assert.ok(button, '应有类型多选控件')
      press(button)
      render()
    },
    pickOrdinary() {
      if (platform === 'desktop') kind = 'ordinary'
      else
        nodes(tree)
          .find((node) => node.props?.testID === 'issue-capsule:ordinary')
          .props.onPress()
      render()
    },
    more() {
      const button = nodes(tree).find((node) =>
        platform === 'desktop'
          ? node.props?.['data-issue-more']
          : node.props?.testID === 'issue-more',
      )
      assert.ok(button, '控制台应提供加载更多按钮')
      press(button)
    },
    retry() {
      const button = nodes(tree).find((node) =>
        platform === 'desktop'
          ? node.props?.children === 'manager.paging.retry'
          : node.props?.label === 'manager.paging.retry',
      )
      assert.ok(button, '错误旁应提供重试按钮')
      ;(button.props.onClick ?? button.props.onPress)()
    },
    async deliverPage() {
      await Promise.resolve()
      loaded = 38
      render()
      // 分页结果与其他看板变化再触发渲染，也不能把列表退回首屏。
      await Promise.resolve()
      render()
    },
  }
}

test('手机 issue 控制台接入滚动恢复，加载/错误/空列表仍有可见反馈，离页不抢恢复位置', () => {
  const f = fixture('mobile')
  f.render()
  assert.ok(f.positions.length)
  assert.equal(f.positions.at(-1).ready, true)
  const first = f.positions.at(-1).memory
  first.y = 240
  f.pickKind('request')
  assert.notEqual(f.positions.at(-1).memory, first)
  f.pickKind('decision')
  assert.equal(f.positions.at(-1).memory.y, 240)
  for (const [load, id] of [
    ['loading', 'issue-loading'],
    ['error', 'issue-load-error'],
    ['empty', 'issue-empty'],
  ]) {
    f.load(load)
    assert.equal(f.has('issue-status-row'), true)
    assert.equal(f.has(id), true)
    assert.equal(f.positions.at(-1).ready, true, '反馈本身不应等数据才显示')
  }
  f.setActive(false)
  const count = f.positions.length
  f.pickKind('ordinary')
  assert.equal(f.positions.length, count)
})

for (const platform of Object.keys(sources)) {
  for (const [kind, status, id] of [
    ['decision', 'answered', 'D-901'],
    ['decision', 'expired', 'D-902'],
    ['request', 'delivered', 'R-901'],
    ['report', 'read', 'P-901'],
    ['suggestion', 'started', 'S-fixture'],
    ['ordinary', 'closed', 'X-901'],
  ]) {
    test(`${platform}：链接 ${id} 切到 ${status}，收起后仍在列表（含后续页）`, () => {
      const f = fixture(platform)
      f.render()
      const issue = {
        id,
        kind,
        status,
        title: '虚构的已处理事项',
        body: '测试正文',
        author: { kind: 'manager' },
        followUp: { state: 'off' },
        discussion: { comments: [] },
        quick: {},
        unread: false,
      }
      f.link(issue, { offPage: true })
      assert.deepEqual(f.filters.at(-1).kinds, [kind])
      assert.deepEqual(f.filters.at(-1).statuses, [status])
      assert.equal(f.visible(id), true)
      f.close(id)
      assert.equal(f.visible(id), true, '不能因为收起取消临时展开而丢失目标')
      f.pickStatus('todo')
      assert.equal(f.visible(id), false, '用户主动改过滤时结束定位，不能强行保留目标')
    })
  }
  test(`${platform}：详情延迟到达时不中途取消链接定位`, () => {
    const f = fixture(platform)
    f.render()
    f.link(
      {
        id: 'D-999',
        kind: 'decision',
        status: 'withdrawn',
        title: '虚构撤回决策',
        body: '正文',
        author: { kind: 'manager' },
        followUp: { state: 'off' },
        discussion: { comments: [] },
        quick: {},
      },
      { delayed: true },
    )
    f.deliverDetail()
    assert.deepEqual(f.filters.at(-1).statuses, ['withdrawn'])
    assert.equal(f.visible('D-999'), true)
    f.changeStatus('answered')
    assert.deepEqual(f.filters.at(-1).statuses, ['answered'], '定位期间使用最新状态')
    assert.equal(f.visible('D-999'), true)
  })
  test(`${platform}：各类别首次进入只查待处理分组（开放、待开始或未读），分组在前，全部选择独立记忆`, () => {
    const f = fixture(platform)
    f.render()
    for (const [kind, first, statuses] of [
      ['decision', 'todo', ['open']],
      ['suggestion', 'todo', ['endorsed']],
      ['request', 'todo', ['open']],
      ['report', 'todo', ['unread']],
      ['ordinary', 'todo', ['open']],
    ]) {
      f.pickKind(kind)
      assert.deepEqual(f.filters.at(-1).statuses, statuses)
      assert.equal(f.statusChoices()[0], first)
      assert.equal(f.statusChoices().at(-1), 'all')
      f.pickStatus('all')
      assert.deepEqual(f.filters.at(-1).statuses, [])
    }
    f.remount()
    for (const kind of ['decision', 'suggestion', 'request', 'report', 'ordinary']) {
      f.pickKind(kind)
      assert.deepEqual(f.filters.at(-1).statuses, [], '明确选过全部不恢复默认')
    }
  })
  test(`${platform}：建议默认排除待审核（归进行中），选进行中后切页和重挂载仍保留`, () => {
    const f = fixture(platform)
    f.render()
    f.pickKind('suggestion')
    assert.deepEqual(f.filters.at(-1).statuses, ['endorsed'])
    f.pickStatus('doing')
    assert.deepEqual(f.filters.at(-1).statuses, ['pending'])
    f.pickKind('decision')
    assert.deepEqual(f.filters.at(-1).statuses, ['open'])
    f.remount()
    f.pickKind('suggestion')
    assert.deepEqual(f.filters.at(-1).statuses, ['pending'])
    assert.equal(f.statusChoices()[0], 'todo')
    assert.equal(f.statusChoices().at(-1), 'all')
  })
  test(`${platform}：概览未读和未完成预设覆盖默认与记忆，不收窄成仅开放`, () => {
    const f = fixture(platform)
    f.render()
    f.preset({ unread: true })
    assert.deepEqual(f.filters.at(-1).statuses, [])
    assert.equal(f.filters.at(-1).unread, true)
    f.preset({ statuses: ['open', 'in_progress', 'blocked'] })
    assert.deepEqual(f.filters.at(-1).statuses, ['open', 'in_progress', 'blocked'])
    assert.equal(f.filters.at(-1).unread, false)
    f.pickKind('report')
    assert.deepEqual(f.filters.at(-1).statuses, ['unread'])
    f.pickKind('ordinary')
    assert.deepEqual(f.filters.at(-1).statuses, ['open', 'in_progress', 'blocked'])
  })
}

for (const platform of Object.keys(sources)) {
  test(`${platform}：自动加载保留冷却，重试和加载更多明确标记手动请求`, () => {
    const f = fixture(platform)
    f.render()
    assert.equal(f.listOptions.at(-1).manual, undefined)
    f.load('error')
    f.retry()
    assert.equal(f.listOptions.at(-1).manual, true)
    f.load('normal')
    f.more()
    assert.equal(f.listOptions.at(-1).manual, true)
    f.pickOrdinary()
    assert.equal(f.listOptions.at(-1).manual, undefined, '切换筛选后的effect仍为自动请求')
  })
  test(`${platform}：首次分类加载更多后不重复查询首屏，切换分类仍查询一次`, async () => {
    const f = fixture(platform)
    f.render()
    f.pickOrdinary()
    f.more()
    await f.deliverPage()
    assert.deepEqual(f.requests, [
      { kind: 'decision', cursor: null },
      { kind: 'ordinary', cursor: null },
      { kind: 'ordinary', cursor: '30' },
    ])
  })
}

for (const platform of Object.keys(sources)) {
  test(`${platform}：issue 多选不切页签，与决策过滤独立记忆，可全选`, () => {
    const f = fixture(platform)
    f.render()
    f.pickOrdinary()
    assert.equal(f.filters.at(-1).discussionsOnly, true)
    f.toggleType('report')
    assert.deepEqual(f.filters.at(-1).kinds, ['ordinary', 'report'])
    f.toggleType('ordinary')
    assert.deepEqual(f.filters.at(-1).kinds, ['report'])
    f.pickDecision()
    assert.deepEqual(f.filters.at(-1).kinds, ['decision'])
    assert.equal(f.filters.at(-1).discussionsOnly, undefined)
    f.pickOrdinary()
    assert.deepEqual(f.filters.at(-1).kinds, ['report'])
    f.toggleType('all')
    assert.deepEqual(f.filters.at(-1).kinds, [])
    assert.equal(f.filters.at(-1).discussionsOnly, true)
  })
}

for (const platform of Object.keys(sources)) {
  test(`${platform}：旧设备只提供 issue 类型，已记住的混合过滤也退回 X-n`, () => {
    const f = fixture(platform)
    f.render()
    f.pickOrdinary()
    f.toggleType('all')
    assert.ok(f.typeChoices().includes('report'))
    f.oldDevice()
    assert.deepEqual(f.typeChoices(), [], '只有一种类型时不出类型行')
    assert.deepEqual(f.filters.at(-1).kinds, ['ordinary'])
    f.pickDecision()
    assert.deepEqual(f.filters.at(-1).kinds, ['decision'])
    assert.equal(f.filters.at(-1).discussionsOnly, undefined)
    f.pickOrdinary()
    assert.deepEqual(f.filters.at(-1).kinds, ['ordinary'])
  })
}

for (const platform of Object.keys(sources)) {
  test(`${platform}：多选三种类型后状态仍是固定分组，单选一组、不随类型膨胀`, () => {
    const f = fixture(platform)
    f.render()
    f.pickOrdinary()
    f.toggleType('decision')
    f.toggleType('request')
    assert.deepEqual(f.filters.at(-1).kinds, ['ordinary', 'decision', 'request'])
    const choices = f.statusChoices()
    assert.deepEqual(choices, ['todo', 'doing', 'unfinished', 'done', 'dropped', 'all'])
    f.pickStatus('done')
    assert.deepEqual(f.filters.at(-1).statuses, [
      'resolved',
      'closed',
      'answered',
      'delivered',
      'replied',
    ])
    f.toggleType('decision')
    assert.deepEqual(
      f.filters.at(-1).statuses,
      ['resolved', 'closed', 'delivered', 'replied'],
      '换类型保留分组',
    )
  })
  test(`${platform}：只选一种类型时细分默认收起，展开后可选单个状态`, () => {
    const f = fixture(platform)
    f.render()
    f.pickOrdinary()
    f.pickStatus('doing')
    assert.equal(
      f.present(['data-issue-filter-detail', 'blocked'], 'issue-filter-detail:blocked'),
      false,
    )
    f.tap(['data-act', 'issue-filter-detail'], 'issue-filter-detail-toggle')
    f.tap(['data-issue-filter-detail', 'blocked'], 'issue-filter-detail:blocked')
    assert.deepEqual(f.filters.at(-1).statuses, ['blocked'])
    // 选着细分时细分行一直在；选“不限”回到整组
    f.tap(['data-issue-filter-detail', 'any'], 'issue-filter-detail:any')
    assert.deepEqual(f.filters.at(-1).statuses, ['in_progress', 'blocked'])
    // 多选类型时没有细分
    f.toggleType('suggestion')
    assert.equal(
      f.present(['data-act', 'issue-filter-detail'], 'issue-filter-detail-toggle'),
      false,
    )
  })
  test(`${platform}：清除筛选回到页签默认、保留排序`, () => {
    const f = fixture(platform)
    f.render()
    f.pickOrdinary()
    f.toggleType('report')
    f.tap(['data-issue-chip', 'unread'], 'issue-filter-only:unread')
    f.pickStatus('all')
    assert.equal(f.filters.at(-1).unread, true)
    f.tap(['data-act', 'issue-filter-clear'], 'issue-filter-reset')
    const last = f.filters.at(-1)
    assert.deepEqual(
      { kinds: last.kinds, statuses: last.statuses, unread: last.unread, authors: last.authors },
      { kinds: ['ordinary'], statuses: ['open'], unread: false, authors: [] },
    )
    assert.equal(
      f.present(['data-act', 'issue-filter-clear'], 'issue-filter-reset'),
      platform === 'mobile',
      '桌面没有生效的筛选时不出清除；手机抽屉里的清除只是变灰',
    )
  })
  test(`${platform}：记住的旧状态组合读不成分组时回到待处理`, () => {
    const f = fixture(platform)
    f.render()
    f.preset({ statuses: ['open', 'resolved'] })
    assert.deepEqual(f.filters.at(-1).statuses, ['open'])
    f.preset({ statuses: ['open', 'in_progress', 'blocked'] })
    assert.deepEqual(f.filters.at(-1).statuses, ['open', 'in_progress', 'blocked'])
    assert.equal(
      f.present(['data-issue-filter-status', 'unfinished'], 'issue-filter-status:unfinished'),
      true,
    )
  })
}
