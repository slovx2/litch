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

function fixture(platform) {
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
  const manager = { deviceId: 'fixture', id: `manager-${platform}` }
  const renderConsole =
    platform === 'desktop' ? output.exports.IssueConsole : output.exports.useIssueConsole
  let kind = 'decision'
  let loaded = 30
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
        list.managerIssuePageKey(manager.id, {
          ...list.DEFAULT_MANAGER_ISSUE_FILTER,
          kinds: [category],
          ...(category === 'ordinary' ? { discussionsOnly: true } : {}),
        }),
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
    const props = {
      manager,
      kind,
      view: { board: { decisions: [], changes: [] } },
      issues: { supported: true, pages, details: {}, error: null },
      disabled: false,
      target: null,
      preset: null,
    }
    const result = renderConsole(props)
    tree = platform === 'desktop' ? result : [result.header, result.body, result.overlays]
    for (const run of effects) run()
  }
  return {
    requests,
    filters,
    render,
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
