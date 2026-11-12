import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from '../../../node_modules/esbuild/lib/main.js'
import { splitMermaid } from '../src/detail/mermaid/segments.ts'

test('手机看板所有正文共用对话的 Mermaid 分段、卡片和全屏查看器', () => {
  const module = { exports: {} }
  const element = (type, props) => ({ type, props })
  const sources = {
    react: { useContext: () => null, useMemo: (fn) => fn(), useState: () => [null, () => {}] },
    'react/jsx-runtime': { jsx: element, jsxs: element },
    'react-native': { View: 'view' },
    '../../ui/theme': { useTheme: () => ({}) },
    '../../ui/i18n': { useT: () => () => '' },
    './presentation': { issueMarkdownStyle: () => ({}), situationMarkdownStyle: () => ({}) },
    './relations': { issueLinks: (text) => text },
    '../../ui/WebLinkMenu': { WebLinkMarkdown: 'markdown' },
    '../../detail/mermaid/MermaidCard': { MermaidCard: 'shared-mermaid' },
    '../../detail/mermaid/MermaidViewer': { MermaidViewer: 'viewer' },
    '../../detail/mermaid/segments': { splitMermaid },
  }
  runInNewContext(
    transformSync(
      readFileSync(new URL('../src/screens/managers/IssueMarkdown.tsx', import.meta.url), 'utf8'),
      { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
    ).code,
    { module, require: (name) => sources[name] ?? {} },
  )
  const tree = module.exports.Markdown({
    text: '正文\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n结尾',
  })
  const [segments] = tree.props.children
  assert.deepEqual(
    segments.map((node) => node.type),
    ['markdown', 'shared-mermaid', 'markdown'],
  )
  assert.equal(segments[1].props.source, 'flowchart LR\n A --> B')
  assert.equal(typeof segments[1].props.onOpen, 'function')
})
