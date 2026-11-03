import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { linuxSuites } from './linux-desktop.mjs'

test('Linux只接已核实集合，浏览器和完整窗口组不能被调用方偷偷迁移', () => {
  assert.deepEqual(linuxSuites('["desktop-portable-unit","desktop-required"]'), [
    'desktop-portable-unit',
    'desktop-required',
  ])
  assert.deepEqual(linuxSuites('["real-engines"]'), ['real-engines'])
  for (const input of ['[]', '["desktop-unit"]', '["client-engines"]', '["--built"]', '{}']) {
    assert.throws(() => linuxSuites(input))
  }
})

test('独立CI保留浏览器原生检查；Linux共享入口不接受skip或重试参数', () => {
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
  assert.match(ci, /suites: '\["desktop-portable-unit","desktop-required"\]'/)
  assert.match(ci, /npm run test:browser --prefix apps\/desktop/)
  const workflow = readFileSync('.github/workflows/linux-desktop.yml', 'utf8')
  assert.match(workflow, /runs-on: ubuntu-24.04/)
  assert.match(workflow, /ref: \$\{\{ inputs.sha \}\}/)
  assert.doesNotMatch(workflow, /skip-missing|continue-on-error/)
})
