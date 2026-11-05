import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { removeTestTree } from './remove-test-tree.mjs'

test('本地 Mac 临时树清理只读 Go 缓存，不修改符号链接外的目录', () => {
  const base = mkdtempSync(join(tmpdir(), 'litch-remove-test-'))
  const root = join(base, 'owned')
  const module = join(root, 'go/module')
  const outside = join(base, 'outside')
  try {
    mkdirSync(module, { recursive: true })
    writeFileSync(join(module, 'go.mod'), 'module fixture')
    chmodSync(module, 0o555)
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep'), 'outside')
    chmodSync(outside, 0o555)
    symlinkSync(outside, join(root, 'external'))
    removeTestTree(root)
    assert.equal(existsSync(root), false)
    assert.equal(statSync(outside).mode & 0o777, 0o555)
    assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'outside')
  } finally {
    removeTestTree(base)
  }
})
