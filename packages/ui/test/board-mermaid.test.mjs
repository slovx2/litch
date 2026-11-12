import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'

test('看板的统一 Markdown 策略复用对话 Mermaid，普通代码保留源码', () => {
  const module = { exports: {} }
  const element = (type, props) => ({ type, props })
  runInNewContext(
    transformSync(
      readFileSync(new URL('../src/manager/BoardMarkdown.tsx', import.meta.url), 'utf8'),
      { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
    ).code,
    {
      module,
      require(name) {
        if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element }
        if (name.endsWith('markdown-policy.ts'))
          return { MarkdownPolicyContext: { Provider: 'provider' } }
        if (name.endsWith('highlight.tsx')) return { languageOf: (value) => value.toLowerCase() }
        if (name.endsWith('Mermaid.tsx')) return { MermaidBlock: 'shared-mermaid' }
        return {}
      },
    },
  )
  const policy = module.exports.BoardMarkdown({ text: '' }).props.children.props.value
  const code = 'flowchart LR\n A --> B'
  const rendered = policy.code('mermaid', code)
  assert.equal(rendered.type, 'shared-mermaid')
  assert.equal(rendered.props.text, code)
  assert.equal(rendered.props.open, false)
  const plain = policy.code('typescript', 'const nebula = 1')
  assert.equal(plain.type, 'pre')
  assert.equal(plain.props.children.type, 'code')
  assert.equal(plain.props.children.props.children, 'const nebula = 1')
})
