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
  assert.match(ci, /domains: '\["browser"\]'/)
  assert.match(ci, /npm run typecheck --prefix apps\/mobile/)
  assert.match(ci, /cd mobile && go test \.\/\.\.\./)
  const workflow = readFileSync('.github/workflows/linux-desktop.yml', 'utf8')
  assert.match(workflow, /runs-on: ubuntu-24.04/)
  assert.match(workflow, /ref: \$\{\{ inputs.sha \}\}/)
  assert.doesNotMatch(workflow, /skip-missing|continue-on-error/)
})

test('候选补充Mac必须经过签名协调，Linux测试/出包不等待签名', () => {
  const read = (name) => readFileSync(`.github/workflows/${name}.yml`, 'utf8')
  const release = read('release')
  assert.match(release, /mac-after-signing: true/)
  assert.match(release, /desktop-macos:\n {4}needs: candidate/)
  assert.match(release, /gate:\n {4}if: \$\{\{ !inputs.bypass-gate \}\}\n {4}needs: candidate/)
  assert.match(read('full'), /adapters-macos:\n {4}needs: \[source, native\]/)
  assert.match(read('mac-native'), /checks:\n {4}needs: priority\n {4}runs-on: macos-15/)
  assert.match(read('mac-priority'), /runs-on: ubuntu-24.04/)
  assert.match(read('full'), /include-browser: false/)
  const adapter = readFileSync('scripts/ci/mac-adapter-checks.mjs', 'utf8')
  assert.match(adapter, /\['claude', 'pi', 'device'\]/)
  assert.match(adapter, /context-window-cli/)
  assert.match(adapter, /package-adapter.mjs/)
})
