import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { PATH_PICKER_EXTENSION, PATH_PICKER_METHOD } from '../../protocol/src/path-picker.mjs'
import { rig } from './helpers.mjs'

test('路径浏览只返回名字和元数据，识别目录、文件、可执行文件及链接，未声明的客户端拒绝', async () => {
  const env = rig({})
  try {
    const root = join(env.stateDir, 'picker')
    mkdirSync(root)
    mkdirSync(join(root, '.hidden'))
    writeFileSync(join(root, 'notes.txt'), 'PRIVATE-CONTENT-MUST-NOT-RETURN')
    writeFileSync(join(root, 'tool.sh'), '#!/bin/sh\necho not-executed')
    chmodSync(join(root, 'tool.sh'), 0o755)
    symlinkSync(join(root, '.hidden'), join(root, 'folder-link'))
    symlinkSync(join(root, 'tool.sh'), join(root, 'tool-link'))
    symlinkSync(join(root, 'missing'), join(root, 'broken-link'))
    const client = env.connect()
    await client.initialize(['harness', PATH_PICKER_EXTENSION])
    const plain = env.connect()
    await plain.initialize(['harness'])
    const undeclared = await plain.fails(PATH_PICKER_METHOD, { path: root })
    assert.equal(undeclared.code, -32600)
    assert.equal(undeclared.data.litch, 'extensionRequired')
    const listed = await client.call(PATH_PICKER_METHOD, { path: root })
    assert.equal(listed.path, root)
    assert.equal(listed.parent, env.stateDir)
    assert.equal(listed.total, 6)
    assert.equal(listed.truncated, false)
    assert.doesNotMatch(JSON.stringify(listed), /PRIVATE-CONTENT|not-executed/)
    const entries = new Map<string, any>(listed.entries.map((entry: any) => [entry.name, entry]))
    assert.equal(entries.get('.hidden').kind, 'dir')
    assert.equal(entries.get('notes.txt').kind, 'file')
    assert.equal(entries.get('notes.txt').executable, false)
    assert.equal(entries.get('tool.sh').executable, process.platform !== 'win32')
    assert.equal(entries.get('folder-link').kind, 'link')
    assert.equal(entries.get('folder-link').targetKind, 'dir')
    assert.equal(entries.get('tool-link').kind, 'link')
    assert.equal(entries.get('tool-link').targetKind, 'file')
    assert.equal(entries.get('broken-link').kind, 'link')
    assert.equal(entries.get('broken-link').targetKind, null)
    for (const path of ['relative', join(root, 'missing'), join(root, 'notes.txt')]) {
      const error = await client.fails(PATH_PICKER_METHOD, { path })
      assert.equal(error.data.litch, 'invalidDirectory')
      assert.equal(error.data.value, path)
    }
    assert.equal(
      (await client.fails(PATH_PICKER_METHOD, { path: root, unexpected: true })).code,
      -32602,
    )
  } finally {
    await env.close()
  }
})
