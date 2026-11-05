import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { goEnvironment, goToolchain } from './go-toolchains.mjs'

test('根与手机模块各用自己的精确工具链，覆盖继承值但不改调用方环境', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'litch-go-plan-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'mobile'))
  writeFileSync(join(root, 'go.mod'), 'module root\n\ngo 1.26.10\n')
  writeFileSync(join(root, 'mobile/go.mod'), 'module mobile\n\ngo 1.27.3\n')
  const parent = { GOTOOLCHAIN: 'local', HOME: '/isolated', GOMODCACHE: '/isolated/modules' }
  assert.equal(goToolchain('.', root), 'go1.26.10')
  assert.equal(goToolchain('mobile', root), 'go1.27.3')
  assert.deepEqual(goEnvironment('mobile', parent, root), { ...parent, GOTOOLCHAIN: 'go1.27.3' })
  assert.equal(goEnvironment('.', parent, root).GOTOOLCHAIN, 'go1.26.10')
  assert.equal(parent.GOTOOLCHAIN, 'local')
  writeFileSync(join(root, 'mobile/go.mod'), 'module mobile\n\ngo 1.27\n')
  assert.throws(() => goToolchain('mobile', root), /补丁版本/)
})
