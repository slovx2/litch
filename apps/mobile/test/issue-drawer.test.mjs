import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'
import { kinds, nodes, threadFixture } from '../../../packages/ui/test/issue-thread-fixture.mjs'

function sheetFixture(kind) {
  const source = transformSync(
    readFileSync(
      new URL('../src/screens/managers/issues/IssueConsole.tsx', import.meta.url),
      'utf8',
    ),
    { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
  ).code
  const state = []
  let cursor = 0
  const element = (type, props) => ({ type, props })
  const module = { exports: {} }
  runInNewContext(source, {
    module,
    require(name) {
      if (name === 'react')
        return {
          useEffect() {},
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
      if (name === '../IssueRelations') return { IssueContext: { Provider: 'context' } }
      if (name === '../Issue') return { Issue: 'quick' }
      if (name === './IssueThread')
        return { IssueThread: 'thread', IssueComposer: 'composer', IssueMetaLine: 'meta' }
      if (name === '../DiscussionDrawer') return { DiscussionDrawer: 'drawer' }
      return {}
    },
  })
  const issue = {
    id: 'D-42',
    kind,
    title: '虚构议题',
    author: { kind: 'manager' },
    followUp: { state: 'on' },
    discussion: { comments: [] },
  }
  const props = {
    issueId: issue.id,
    board: { posts: [issue] },
    issues: { details: { [issue.id]: issue } },
    commands: {},
    manager: {},
    features: {},
    suggestions: [],
  }
  return () => {
    cursor = 0
    return module.exports.IssueSheetDrawer(props)
  }
}

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
