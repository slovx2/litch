import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'
import { proposalSummary } from '../../../packages/ui/src/tree/proposal-brief.ts'

const { code } = transformSync(
  readFileSync(new URL('../src/detail/proposals/ProposalBrief.tsx', import.meta.url), 'utf8'),
  { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
)
function fixture(props) {
  let open = false
  const element = (type, props) => ({ type, props: props ?? {} })
  const stubs = {
    react: {
      useState: () => [
        open,
        (value) => {
          open = value
        },
      ],
    },
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'fragment' },
    'react-native': { Pressable: 'button', Text: 'text', View: 'view' },
    '../../../../../packages/ui/src/tree/proposal-brief.ts': { proposalSummary },
    '../../ui/i18n': { useT: () => (key) => key },
    '../../ui/theme': { useTheme: () => ({ c: {}, font: { size: {} } }) },
    '../CardMarkdown': { CardMarkdown: 'markdown' },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(
    (name) => {
      assert.ok(name in stubs, name)
      return stubs[name]
    },
    module,
    module.exports,
  )
  return () => module.exports.ProposalBrief({ ...props, testID: 'brief' })
}
function nodes(value) {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(nodes)
  return [value, ...nodes(value.props?.children)]
}
for (const background of ['', '需要补测试，防止再次丢数据。具体约束。']) {
  test(`手机各入口共用简报支持默认折叠、展开全文、再收起：背景=${!!background}`, () => {
    const render = fixture({ background, prompt: '执行步骤。完整任务。' })
    let tree = nodes(render())
    assert.equal(
      tree.some((n) => n.type === 'markdown'),
      false,
    )
    assert.equal(
      tree.find((n) => n.props.testID === 'brief:summary').props.children,
      proposalSummary(background, '执行步骤。完整任务。'),
    )
    tree.find((n) => n.type === 'button').props.onPress()
    tree = nodes(render())
    assert.deepEqual(
      tree.filter((n) => n.type === 'markdown').map((n) => n.props.text),
      [...(background ? [background] : []), '执行步骤。完整任务。'],
    )
    assert.equal(tree.find((n) => n.type === 'button').props.accessibilityState.expanded, true)
    tree.find((n) => n.type === 'button').props.onPress()
    assert.equal(
      nodes(render()).some((n) => n.type === 'markdown'),
      false,
    )
  })
}
