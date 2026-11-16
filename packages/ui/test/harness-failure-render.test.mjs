import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'
import { harnessFailureText } from '../src/devices/harness-failure.ts'
import { translator } from '../src/i18n/index.ts'

const t = translator('zh-CN')
const harness = {
  id: 'codex',
  name: 'Codex',
  badge: 'CX',
  version: '0.164.0',
  state: 'unavailable',
  down: 'startFailed',
  reason: '启动失败',
  detail: {
    'zh-CN': '引擎启动失败：socket directory is not private to the current user',
    en: 'The engine failed to start: socket directory is not private to the current user',
  },
}
const device = { id: 'local', harnesses: [harness] }
const element = (type, props) => ({ type, props })
const nodes = (tree) =>
  Array.isArray(tree)
    ? tree.flatMap(nodes)
    : tree && typeof tree === 'object'
      ? [tree, ...nodes(tree.props?.children)]
      : []

function load(url, extra = '') {
  const module = { exports: {} }
  const source = transformSync(readFileSync(url, 'utf8') + extra, {
    loader: 'tsx',
    format: 'cjs',
    jsx: 'automatic',
  }).code
  runInNewContext(source, {
    module,
    exports: module.exports,
    require(name) {
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element }
      if (name === 'react') return { useState: (initial) => [initial, () => {}] }
      if (name === 'react-native')
        return {
          Text: 'text',
          View: 'view',
          Pressable: 'button',
          StyleSheet: { create: (styles) => styles },
        }
      if (name.endsWith('/appearance.ts') || name.endsWith('/i18n')) return { useT: () => t }
      if (name.endsWith('/theme')) return { useTheme: () => ({ c: {}, radius: {} }) }
      if (name.endsWith('/harness-failure.ts')) return { harnessFailureText }
      if (name.endsWith('/cli-presentation.ts'))
        return { cliPresentation: () => ({ selected: null, candidates: [] }) }
      if (name.endsWith('/services.tsx')) return { useServices: () => ({ channel: {} }) }
      if (name.endsWith('/services'))
        return { useChannel: () => ({}), useBusy: () => [false, () => {}] }
      if (name === '@react-navigation/native') return { useNavigation: () => ({}) }
      if (name.endsWith('/HarnessList.tsx')) return { HarnessWhy: 'harness-why' }
      if (name.endsWith('/controls')) return { Row: 'row' }
      return {}
    },
  })
  return module.exports
}

test('桌面设备页列表直接渲染完整失败原因，不必进入 harness 详情或悬停', () => {
  const { HarnessBlock } = load(new URL('../src/devices/manage/HarnessBlock.tsx', import.meta.url))
  const render = (value) =>
    HarnessBlock({
      device,
      harnessId: 'codex',
      harness: value,
      pending: false,
      settings() {},
      children: null,
    })
  assert.equal(nodes(render(harness)).filter((node) => node.type === 'harness-why').length, 1)
  assert.equal(
    nodes(render({ ...harness, state: 'ready' })).filter((node) => node.type === 'harness-why')
      .length,
    0,
  )
  assert.equal(
    nodes(render({ ...harness, down: 'notInstalled' })).filter(
      (node) => node.type === 'harness-why',
    ).length,
    0,
  )
})

test('手机设备列表与 harness 详情均有完整可选中的具体原因，不受 Row 两行省略限制', () => {
  const { HarnessHead } = load(
    new URL('../../../apps/mobile/src/screens/devices/ManageSection.tsx', import.meta.url),
    '\nexport { HarnessHead }',
  )
  for (const detail of [false, true]) {
    const tree = HarnessHead({
      deviceId: 'local',
      harness,
      enable: null,
      snapshot: { values: {}, pendingRestart: [] },
      detail,
    })
    const failure = nodes(tree).find((node) => node.props?.testID === 'harness:codex:failure')
    assert.ok(failure)
    assert.match(failure.props.children, /socket directory is not private/)
    assert.equal(failure.props.selectable, true)
    assert.equal(failure.props.numberOfLines, undefined)
  }
})
