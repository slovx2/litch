import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'
import { withProposalNote } from '../../../packages/ui/src/tree/proposal-operation.ts'

// 执行真实动作 hook，替换原生 UI 和数据订阅，不加载 React 或模拟器。
const { code } = transformSync(
  readFileSync(new URL('../src/detail/proposals/ProposalActs.tsx', import.meta.url), 'utf8'),
  { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
)

function actions({
  manager = false,
  managerSource = false,
  busy = false,
  online = true,
  worktree = false,
  block = null,
  note = '',
} = {}) {
  const navigations = []
  const starts = []
  const stubs = {
    '@litch/core': {
      keys: { device: () => 'device', summary: () => 'summary' },
      managerMark: () => (manager ? { role: 'manager' } : null),
    },
    '@react-navigation/native': {
      useNavigation: () => ({ navigate: (...args) => navigations.push(args) }),
    },
    react: { useState: (value) => [value === '' ? note : value, () => {}] },
    'react/jsx-runtime': {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
      Fragment: 'Fragment',
    },
    'react-native': { StyleSheet: { create: (value) => value }, Text: 'Text', View: 'View' },
    '../../shell/services': {
      useChannel: () => ({}),
      useKey: (key) =>
        key === 'device' ? { connection: online ? 'online' : 'offline' } : { id: 'source' },
    },
    '../../ui/i18n': { useT: () => (key) => key },
    './hooks': {
      useProposalAct: () => ({ busy, dismiss() {}, accept: (value) => starts.push(value) }),
    },
    '../../../../../packages/ui/src/tree/proposal-operation.ts': { withProposalNote },
    './ModelLimitNotice': { ModelLimitNotice: 'ModelLimitNotice' },
    './ProposalNote': { ProposalNote: 'ProposalNote' },
    './WorktreeSwitch': { useWorktreesOn: () => true, WorktreeSwitch: 'WorktreeSwitch' },
    '../../../../../packages/ui/src/tree/useProposalWorktree.ts': {
      useProposalWorktree: () => block,
    },
    '../../../../../packages/ui/src/tree/sandbox.ts': {},
    '../../ui/kit/controls': { Button: 'Button' },
    '../../ui/kit/Icon': {},
    '../../ui/kit/overlays': {},
    '../../ui/theme': { useTheme: () => ({ c: {}, font: { size: {} } }) },
    './logic': {},
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in stubs, `未定义的依赖：${name}`)
      return stubs[name]
    },
    module,
    module.exports,
  )
  return {
    // biome-ignore lint/correctness/useHookAtTopLevel: 单测用无 React 的 hook 替身直接检查菜单与导航。
    acts: module.exports.useProposalActs('local', 'source', 'p', worktree, managerSource, '原任务'),
    render: module.exports.ProposalActsRow,
    navigations,
    starts,
  }
}

test('手机工作树预检失败时开始禁用、理由可见，工作树开关仍可修改', () => {
  const { acts, render } = actions({
    manager: true,
    worktree: true,
    block: 'worktree.check.notRepo',
  })
  const rows = []
  function visit(node) {
    if (!node || typeof node !== 'object') return
    rows.push(node)
    for (const child of [node.props?.children].flat()) visit(child)
  }
  visit(render({ acts }))
  assert.equal(rows.find((r) => r.props?.testID === 'proposal:p:start').props.disabled, true)
  assert.equal(rows.find((r) => r.type === 'WorktreeSwitch').props.disabled, false)
  assert.equal(rows.find((r) => r.type === 'WorktreeSwitch').props.value, true)
  assert.ok(rows.some((r) => r.type === 'Text' && r.props.children === 'worktree.check.notRepo'))
})

for (const source of [{}, { manager: true }, { managerSource: true }]) {
  test(`手机建议菜单保留编辑并打开当前卡片的编辑页：${JSON.stringify(source)}`, () => {
    const { acts, navigations } = actions(source)
    assert.equal(acts.sourceIsManager, !!(source.manager || source.managerSource))
    assert.deepEqual(
      acts.menu.map((item) => item.testID),
      ['proposal:p:edit', 'proposal:p:dismiss'],
    )
    assert.equal(acts.menu[0].disabled, undefined)
    acts.menu[0].onPress()
    assert.deepEqual(navigations, [
      ['ProposalStart', { deviceId: 'local', sessionId: 'source', proposalId: 'p', note: '' }],
    ])
  })
}

test('手机卡片的补充说明同时传给编辑页和开始请求', () => {
  const { acts, navigations, starts } = actions({ note: '先检查现有实现' })
  acts.menu[0].onPress()
  assert.equal(navigations[0][1].note, '先检查现有实现')
  acts.start()
  assert.deepEqual(starts, [
    { worktree: false, prompt: '原任务\n\n用户补充说明：\n先检查现有实现' },
  ])
})

test('经理建议编辑仍受离线和正在提交的限制', () => {
  assert.equal(
    actions({ manager: true, online: false }).acts.menu[0].disabled,
    'devices.state.offline',
  )
  assert.deepEqual(actions({ manager: true, busy: true }).acts.menu, [])
})
