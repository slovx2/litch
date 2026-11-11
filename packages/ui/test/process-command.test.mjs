import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'

const source = transformSync(
  readFileSync(new URL('../src/transcript/activity.tsx', import.meta.url), 'utf8'),
  { loader: 'tsx', format: 'cjs', jsx: 'automatic' },
).code
const element = (type, props) => ({ type, props })
const module = { exports: {} }
runInNewContext(source, {
  module,
  require(name) {
    if (name === 'react') return { memo: (fn) => fn }
    if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'fragment' }
    return {}
  },
})
const command = 'cd /srv/nebula && npm run verify -- --report detailed-results.json'
for (const status of ['inProgress', 'completed', 'failed', 'declined'])
  test(`${status}：无输出也显示完整命令，命令在输出之前且不设置截断`, () => {
    const item = { command, status, output: '', elided: null }
    const node = module.exports.CommandDetail({ item })
    const [full, output] = node.props.children
    assert.equal(full.type, 'pre')
    assert.equal(full.props.children, command)
    assert.equal(full.props['data-command-source'], true)
    assert.equal(output, null)
    item.output = 'Streaming output\n'
    const withOutput = module.exports.CommandDetail({ item }).props.children
    assert.equal(withOutput[0].props.children, command)
    assert.equal(withOutput[1].props.item, item)
    assert.equal(withOutput[1].type, module.exports.OutputWell)
  })
