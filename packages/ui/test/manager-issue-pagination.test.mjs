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
const sources = {
  desktop: new URL('../src/manager/issues/IssueConsole.tsx', import.meta.url),
  mobile: new URL(
    '../../../apps/mobile/src/screens/managers/issues/IssueConsole.tsx',
    import.meta.url,
  ),
}
const compiled = Object.fromEntries(
  await Promise.all(
    Object.entries(sources).map(async ([platform, path]) => [
      platform,
      (
        await transform(readFileSync(path, 'utf8'), {
          loader: 'tsx',
          format: 'cjs',
          jsx: 'automatic',
        })
      ).code,
    ]),
  ),
)

let fixtureSeq = 0
function fixture(platform) {
  let discussions = true
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
  const filters = []
  const commands = {
    read: () => Promise.resolve(),
    list: (filter, options = {}) => {
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
  const output = { exports: {} }
  runInNewContext(compiled[platform], {
    module: output,
    require(name) {
      if (modules[name]) return modules[name]
      if (name.endsWith('/manager-issue-list.mts')) return list
      if (name.endsWith('/appearance.ts') || name.endsWith('/i18n')) return { useT: () => t }
      if (name.endsWith('/theme'))
        return { useTheme: () => ({ c: {}, font: { size: {} }, radius: {} }) }
      if (name.endsWith('/discussion-pane.ts')) return { useDiscussionPane: () => null }
      if (name === './data.ts' || name === './data')
        return { useIssueCommands: () => commands, useIssueCounts: () => null }
      // 子组件只保留 JSX 节点，不运行无关绘制。
      return {}
    },
  })
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
      issues: { supported: true, discussions, pages, details, error: null },
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
  function filterControl() {
    if (platform === 'mobile') {
      nodes(tree)
        .find((node) => node.props?.testID === 'issue-filter-open')
        .props.onPress()
      render()
    }
    const control = nodes(tree).find(
      (node) => typeof node.type === 'function' && node.props?.filter && node.props?.onChange,
    )
    return nodes(control.type(control.props))
  }
  const statusKey = (node) =>
    platform === 'desktop'
      ? node.props?.['data-issue-filter-status']
      : node.props?.testID?.match(/^issue-filter-status:(.+)$/)?.[1]
  return {
    requests,
    filters,
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
      ;(button.props.onClick ?? button.props.onPress)()
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
      if (platform === 'mobile') {
        nodes(tree)
          .find((node) => node.props?.testID === 'issue-filter-open')
          .props.onPress()
        render()
      }
      const control = nodes(tree).find(
        (node) => typeof node.type === 'function' && node.props?.filter && node.props?.onChange,
      )
      return nodes(control.type(control.props)).flatMap((node) => {
        const value =
          platform === 'desktop'
            ? node.props?.['data-issue-filter-kind']
            : node.props?.testID?.match(/^issue-filter-kind:(.+)$/)?.[1]
        return value ? [value] : []
      })
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
      if (platform === 'mobile') {
        nodes(tree)
          .find((node) => node.props?.testID === 'issue-filter-open')
          .props.onPress()
        render()
      }
      const control = nodes(tree).find(
        (node) => typeof node.type === 'function' && node.props?.filter && node.props?.onChange,
      )
      const content = control.type(control.props)
      const button = nodes(content).find((node) =>
        platform === 'desktop'
          ? node.props?.['data-issue-filter-kind'] === type
          : node.props?.testID === `issue-filter-kind:${type}`,
      )
      assert.ok(button, '应有类型多选控件')
      ;(button.props.onClick ?? button.props.onPress)()
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
      f.pickStatus(kind === 'report' ? 'unread' : kind === 'suggestion' ? 'endorsed' : 'open')
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
  test(`${platform}：各类别首次进入只查开放、待开始或未读，选项在前，全部选择独立记忆`, () => {
    const f = fixture(platform)
    f.render()
    for (const [kind, first, statuses] of [
      ['decision', 'open', ['open']],
      ['suggestion', 'endorsed', ['endorsed']],
      ['request', 'open', ['open']],
      ['report', 'unread', ['unread']],
      ['ordinary', 'open', ['open']],
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
  test(`${platform}：建议默认排除待审核，手动选择待审核后切页和重挂载仍保留`, () => {
    const f = fixture(platform)
    f.render()
    f.pickKind('suggestion')
    assert.deepEqual(f.filters.at(-1).statuses, ['endorsed'])
    // 手机状态支持多选：先清空默认选择，再只选待审核。
    f.pickStatus('all')
    f.pickStatus('pending')
    assert.deepEqual(f.filters.at(-1).statuses, ['pending'])
    f.pickKind('decision')
    assert.deepEqual(f.filters.at(-1).statuses, ['open'])
    f.remount()
    f.pickKind('suggestion')
    assert.deepEqual(f.filters.at(-1).statuses, ['pending'])
    assert.equal(f.statusChoices()[0], 'endorsed')
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
    assert.deepEqual(f.typeChoices(), ['ordinary'])
    assert.deepEqual(f.filters.at(-1).kinds, ['ordinary'])
    f.pickDecision()
    assert.deepEqual(f.filters.at(-1).kinds, ['decision'])
    assert.equal(f.filters.at(-1).discussionsOnly, undefined)
    f.pickOrdinary()
    assert.deepEqual(f.filters.at(-1).kinds, ['ordinary'])
  })
}
