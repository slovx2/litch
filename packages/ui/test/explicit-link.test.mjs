import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { lex } from '../src/transcript/markdown-lex.ts'

const element = (type, props) => ({ type, props })
const module = { exports: {} }
const pass = ({ children }) => children
const sources = {
  react: { memo: (fn) => fn, useContext: () => null, useRef: () => ({ current: null }) },
  'react/jsx-runtime': { jsx: element, jsxs: element },
  './markdown-lex.ts': { lex },
  './markdown-policy.ts': { MarkdownPolicyContext: {} },
  './FileLinks.tsx': {
    Link: ({ href, children }) => element('a', { href, children }),
    Prose: ({ text }) =>
      text.includes('/') ? element('a', { href: 'auto-path', children: text }) : text,
    CodeSpan: ({ text }) => element('a', { href: 'auto-code', children: text }),
  },
  './ManagerReferences.tsx': {
    TranscriptReferences: ({ text, plain }) => plain(text),
    TranscriptReferencesContext: { Provider: 'scope' },
  },
  './SessionMentions.tsx': { HAS_MENTION: /@/, AnswerMentions: ({ text, plain }) => plain(text) },
  './comments/Cite.tsx': { HAS_CITE: /NEVER-CITE/ },
  './media/Images.tsx': { MessageImages: pass },
}
runInNewContext(
  transformSync(readFileSync(new URL('../src/transcript/Markdown.tsx', import.meta.url), 'utf8'), {
    loader: 'tsx',
    format: 'cjs',
    jsx: 'automatic',
  }).code,
  { module, require: (name) => sources[name] ?? {} },
)
const walk = (node) =>
  Array.isArray(node)
    ? node.flatMap(walk)
    : !node || typeof node !== 'object'
      ? []
      : typeof node.type === 'function'
        ? walk(node.type(node.props))
        : [node, ...walk(node.props?.children)]

for (const label of [
  'nebula-link-test/',
  'docs/report.md',
  '`nebula-link-test/`',
  '**docs/** *report.md*',
  'https://nebula.example.invalid/docs/report.md',
  '![星云图](/tmp/nebula.png)',
])
  test(`显式链接标签仅展示格式，不生成第二个路径/网页目标：${label}`, () => {
    const nodes = walk(
      module.exports.Markdown({ text: `[${label}](/tmp/nebula-link-test/)`, streaming: false }),
    )
    const targets = nodes.filter((node) => node.type === 'a' || node.type === 'button')
    assert.equal(targets.length, 1)
    assert.equal(targets[0].props.href, '/tmp/nebula-link-test/')
    if (label.startsWith('`'))
      assert.equal(
        nodes.some((node) => node.type === 'code'),
        true,
      )
    if (label.startsWith('**'))
      assert.equal(
        nodes.some((node) => node.type === 'strong'),
        true,
      )
  })
