import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'
import { kinds, nodes, threadFixture } from '../../../packages/ui/test/issue-thread-fixture.mjs'

function sheetFixture(kind, options = {}) {
  const source = transformSync(
    readFileSync(
      new URL('../src/screens/managers/issues/IssueConsole.tsx', import.meta.url),
      'utf8',
    ),
    { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
  ).code
  const state = []
  const effects = []
  const calls = []
  let cursor = 0
  const element = (type, props) => ({ type, props })
  const module = { exports: {} }
  runInNewContext(source, {
    module,
    require(name) {
      if (name === 'react')
        return {
          useEffect(run) {
            effects.push(run)
          },
          useRef(initial) {
            const index = cursor++
            if (!(index in state)) state[index] = { current: initial }
            return state[index]
          },
          useState(initial) {
            const index = cursor++
            if (!(index in state)) state[index] = initial
            return [
              state[index],
              (value) => {
                state[index] = value
              },
            ]
          },
        }
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element }
      if (name === 'react-native') return { StyleSheet: { create: (styles) => styles } }
      if (name.endsWith('/i18n')) return { useT: () => (key) => key }
      if (name.endsWith('/theme')) return { useTheme: () => ({ c: {}, font: { size: {} } }) }
      if (name.endsWith('/services'))
        return {
          useChannel: () => ({
            command: async (...args) => {
              calls.push(args)
            },
          }),
        }
      if (name === '../IssueRelations') return { IssueContext: { Provider: 'context' } }
      if (name === '../Issue') return { Issue: 'quick' }
      if (name === './IssueThread')
        return { IssueThread: 'thread', IssueComposer: 'composer', IssueMetaLine: 'meta' }
      if (name === '../DiscussionDrawer') return { DiscussionDrawer: 'drawer' }
      return {}
    },
  })
  const issue = {
    id: kind === 'suggestion' ? 'S-nebula' : 'D-42',
    kind,
    title: '虚构议题',
    author: { kind: 'manager' },
    followUp: { state: 'on' },
    discussion: { comments: [] },
  }
  const props = {
    issueId: issue.id,
    board: { posts: options.empty ? [] : [issue] },
    issues: { details: { [issue.id]: issue } },
    commands: {},
    manager: { deviceId: 'nebula', id: 'manager' },
    features: { paging: options.paged === true },
    suggestions: [],
  }
  const render = () => {
    cursor = 0
    effects.length = 0
    return module.exports.IssueSheetDrawer(props)
  }
  render.effects = () =>
    effects.splice(0).forEach((run) => {
      run()
    })
  render.calls = calls
  render.loaded = () => {
    props.board.posts = [issue]
  }
  return render
}

test('手机分页建议详情：首屏只有 issue 外壳时请求原卡，加载后出现简报和操作', async () => {
  const render = sheetFixture('suggestion', { paged: true, empty: true })
  let tree = render()
  render.effects()
  await Promise.resolve()
  assert.deepEqual(JSON.parse(JSON.stringify(render.calls)), [
    ['managers.board.detail', { deviceId: 'nebula', managerId: 'manager', id: 'S-nebula' }],
  ])
  assert.ok(nodes(tree).some((node) => node.props?.testID === 'issue-quick-loading'))
  render.loaded()
  tree = render()
  assert.ok(nodes(tree).some((node) => node.type === 'quick'))
})

for (const kind of kinds) {
  test(`${kind}：手机抽屉标题入口控制折叠正文，讨论输入框保留`, () => {
    const render = sheetFixture(kind)
    let tree = render()
    if (kind !== 'ordinary') {
      nodes(tree)
        .find((node) => node.type === 'quick')
        .props.onTalk(true)
      tree = render()
    }
    assert.equal(tree.props.footer.type, 'composer')
    assert.equal(tree.props.bodyAction.expanded, false)
    assert.equal(nodes(tree).find((node) => node.type === 'thread').props.bodyOpen, false)
    tree.props.bodyAction.onPress()
    tree = render()
    assert.equal(nodes(tree).find((node) => node.type === 'thread').props.bodyOpen, true)
    tree.props.bodyAction.onPress()
    tree = render()
    assert.equal(nodes(tree).find((node) => node.type === 'thread').props.bodyOpen, false)
  })
  test(`${kind}：手机讨论只显示时间线，正文按需展开且可收起`, () => {
    const f = threadFixture('mobile', kind)
    f.render()
    assert.equal(f.original(), false)
    f.setBody(true)
    assert.equal(f.original(), true)
    f.setBody(false)
    assert.equal(f.original(), false)
  })
  test(`${kind}：手机完整讨论页的正文默认折叠`, () => {
    const f = threadFixture('mobile', kind, { bodyMode: 'folded' })
    f.render()
    assert.equal(f.original(), false)
    f.reveal()
    assert.equal(f.original(), true)
    f.reveal()
    assert.equal(f.original(), false)
  })
}

test('完整议题页：D-n 关联 X-n 在讨论区那一行看得到，卡上已有的关联不再重复', () => {
  const issue = (target) => ({ kind: 'issue', target })
  const f = threadFixture('mobile', 'decision', {
    bodyMode: 'folded',
    relations: [
      { from: issue('D-42'), to: issue('I-1') },
      { from: issue('X-3'), to: issue('D-42') },
    ],
  })
  f.render()
  f.reveal()
  const text = (tree) =>
    tree.flatMap((node) => [node.props?.children].flat().filter((part) => typeof part === 'string'))
  const fold = () => f.render().find((node) => node.props?.testID === 'issue-relations-toggle')
  assert.ok(fold(), '有关联一行')
  assert.ok(text(nodes(fold())).includes('manager.relations'))
  assert.ok(
    nodes(fold()).some((node) => [node.props?.children].flat().includes(1)),
    '只数 X-3 一条',
  )
  fold().props.onToggle()
  const shown = text(f.render())
  assert.ok(shown.includes('X-3'), '展开后看得到 X-3')
  assert.ok(!shown.includes('I-1'), '卡上已有的 I-1 不重复')
})

for (const kind of kinds) {
  test(`${kind}：按设备跟进状态显示提示，报告仅显式暂停才提示`, () => {
    for (const state of ['on', 'off']) {
      const tree = threadFixture('mobile', kind, { followUp: state }).render()
      assert.equal(
        tree.some((node) => node.props?.testID === 'issue-follow-note'),
        state === 'off',
      )
    }
  })
}
