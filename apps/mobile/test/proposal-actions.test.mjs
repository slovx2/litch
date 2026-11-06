import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'

// 执行真实动作 hook，替换原生 UI 和数据订阅，不加载 React 或模拟器。
const { code } = transformSync(
  readFileSync(new URL('../src/detail/proposals/ProposalActs.tsx', import.meta.url), 'utf8'),
  { loader: 'tsx', format: 'cjs' },
)

function actions({ manager = false, managerSource = false, busy = false, online = true } = {}) {
  const navigations = []
  const stubs = {
    '@litch/core': {
      keys: { device: () => 'device', summary: () => 'summary' },
      managerMark: () => (manager ? { role: 'manager' } : null),
    },
    '@react-navigation/native': {
      useNavigation: () => ({ navigate: (...args) => navigations.push(args) }),
    },
    react: { useState: (value) => [value, () => {}] },
    'react-native': { StyleSheet: { create: (value) => value } },
    '../../shell/services': {
      useKey: (key) =>
        key === 'device' ? { connection: online ? 'online' : 'offline' } : { id: 'source' },
    },
    '../../ui/i18n': { useT: () => (key) => key },
    './hooks': { useProposalAct: () => ({ busy, dismiss() {} }) },
    './WorktreeSwitch': { useWorktreesOn: () => false },
    '../../../../../packages/ui/src/tree/sandbox.ts': {},
    '../../ui/kit/controls': {},
    '../../ui/kit/Icon': {},
    '../../ui/kit/overlays': {},
    '../../ui/theme': {},
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
    acts: module.exports.useProposalActs('local', 'source', 'p', false, managerSource),
    navigations,
  }
}

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
      ['ProposalStart', { deviceId: 'local', sessionId: 'source', proposalId: 'p' }],
    ])
  })
}

test('经理建议编辑仍受离线和正在提交的限制', () => {
  assert.equal(
    actions({ manager: true, online: false }).acts.menu[0].disabled,
    'devices.state.offline',
  )
  assert.deepEqual(actions({ manager: true, busy: true }).acts.menu, [])
})
