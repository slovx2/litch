import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkAutomationBoundary, checkClosure, importsOf } from './automation-boundary.mjs'

test('依赖闭包守住唯一源与设备自包含投影', () => {
  assert.ok(checkAutomationBoundary() >= 10)
})

test('检查器识别 type/re-export/import type/dynamic import，拒绝计算导入', () => {
  assert.deepEqual(
    importsOf(
      "import type { X } from './a.mjs'; export * from './b.mjs'; type Y = import('./c.mjs').Y; import('./d.mjs');",
    ),
    ['./a.mjs', './b.mjs', './c.mjs', './d.mjs'],
  )
  assert.throws(() => importsOf('import(name)'), /字面量/)
  assert.throws(() => importsOf('/// <reference types="node" />'), /reference types/)
})

test('拒绝 Electron/npm 和仓库外文件，不能因存在该文件就放行', () => {
  const temp = mkdtempSync(join(tmpdir(), 'automation-boundary-')),
    src = join(temp, 'src')
  mkdirSync(src)
  writeFileSync(join(temp, 'outside.mts'), 'export {}')
  for (const specifier of ['electron', '../outside.mjs']) {
    writeFileSync(join(src, 'index.mts'), `export * from '${specifier}'`)
    assert.throws(() => checkClosure([join(src, 'index.mts')], src), /依赖/)
  }
})
