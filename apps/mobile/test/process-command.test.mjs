// 真实步骤组件的 props/交互回归；不把 RN Web 布局当作原生触摸证明。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'

const source = transformSync(
  readFileSync(new URL('../src/detail/steps.tsx', import.meta.url), 'utf8'),
  { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
).code
const nodes = (node) =>
  Array.isArray(node)
    ? node.flatMap(nodes)
    : !node || typeof node !== 'object'
      ? []
      : [node, ...nodes(node.props?.children)]
function fixture() {
  const element = (type, props) => ({ type, props })
  const module = { exports: {} }
  const t = Object.assign((key) => key, { text: (value) => value })
  const modules = {
    react: { memo: (fn) => fn, Children: { toArray: (children) => [children] } },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': {
      View: 'view',
      Text: 'text',
      Pressable: 'press',
      ScrollView: 'scroll',
      StyleSheet: { create: (styles) => styles },
    },
    '../ui/theme': { useTheme: () => ({ c: {}, font: { size: {} }, radius: {} }) },
    '../ui/i18n': { useT: () => t },
    './cells': {
      styles: { grow: { flex: 1, minWidth: 0 } },
      useTicking: () => 104000,
      useLasting: () => false,
    },
    './context': {
      useTranscript: () => ({}),
      useToggleInPlace: () => () => {},
      useBackgroundView: () => null,
    },
    '../ui/kit/Icon': { Icon: 'icon', Caret: 'caret' },
    '../ui/kit/marks': { StatusMark: 'status' },
    '../../../../packages/ui/src/app/format.ts': {
      elapsed: () => '1m44s',
      duration: () => '1m44s',
    },
  }
  runInNewContext(source, { module, require: (name) => modules[name] ?? {} })
  return module.exports
}
for (const state of ['running', 'done', 'failed', 'declined'])
  test(`${state}：命令独占剩余宽度、尾部省略，状态图标可读`, () => {
    const { StepCell } = fixture()
    const tree = StepCell({
      row: {
        key: 'step',
        turnId: 't',
        state,
        item: { id: 'command', kind: 'command', command: 'cd /srv/nebula && verify', startedAt: 1 },
        durationMs: 104000,
        exitCode: state === 'failed' ? 7 : 0,
        expanded: false,
      },
    })
    const flat = nodes(tree)
    const mark = flat.find((n) => n.props?.accessibilityRole === 'image')
    assert.ok(mark.props.accessibilityLabel)
    assert.equal(mark.props.style.flexShrink, 0)
    const command = flat.find((n) => n.props?.children === '$ cd /srv/nebula && verify')
    assert.equal(command.props.numberOfLines, 1)
    assert.equal(command.props.ellipsizeMode, 'tail')
    const stateText = flat
      .filter((n) => n.type === 'text')
      .map((n) => n.props.children)
      .filter((x) => typeof x === 'string')
      .join(' ')
    assert.equal(/command.running|detail.step.failed|detail.step.declined/.test(stateText), false)
  })
test('运行中无输出仍能展开，完整命令可选中，收到增量后复用输出区', () => {
  const { StepCell } = fixture()
  const row = {
    key: 'step',
    turnId: 't',
    state: 'running',
    item: {
      id: 'command',
      kind: 'command',
      command: 'cd /srv/nebula && verify',
      startedAt: 1,
      elided: null,
    },
    expanded: true,
    output: '',
    tail: '',
    durationMs: null,
    exitCode: null,
  }
  const tree = StepCell({ row })
  const detail = nodes(tree).find(
    (n) => typeof n.type === 'function' && n.type.name === 'StepDetail',
  )
  const commandDetail = detail.type(detail.props)
  let rendered = commandDetail.type(commandDetail.props)
  const full = nodes(rendered).find((n) => n.props?.testID === 'command-source')
  assert.equal(full.props.selectable, true)
  assert.equal(full.props.numberOfLines, undefined)
  assert.equal(full.props.children, row.item.command)
  assert.equal(
    nodes(rendered).some((n) => n.type === 'text' && n !== full),
    false,
  )
  row.output = 'Incremental output\n'
  rendered = commandDetail.type(commandDetail.props)
  assert.ok(nodes(rendered).some((n) => n.props?.children === 'Incremental output'))
})
