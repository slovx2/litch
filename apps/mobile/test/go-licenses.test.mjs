import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { collectGoLicenses } from '../../../mobile/licenses.mjs'

test('空缓存先下载 go.mod 锁定的绑定运行时，再收齐两平台许可', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'litch-go-licenses-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const modules = [
    ['example.test/shared', 'v1.2.3'],
    ['example.test/ios', 'v2.3.4'],
    ['golang.org/x/mobile', 'v0.0.0-20260803200217-62cee1672c8e'],
  ]
  const directory = (name) => join(root, 'empty module cache', name)
  const download = (name) => {
    mkdirSync(directory(name), { recursive: true })
    writeFileSync(join(directory(name), 'LICENSE'), `${name} 完整许可正文`)
  }
  const metadata = ([name, version]) =>
    `${name}\t${version}\t${existsSync(directory(name)) ? directory(name) : ''}`
  const calls = []
  const runGo = (target, ...args) => {
    calls.push([target, ...args])
    if (args[0] === 'mod') {
      assert.deepEqual(args, ['mod', 'download', 'golang.org/x/mobile'])
      download(modules[2][0])
      return ''
    }
    if (args[1] === '-deps') {
      const selected = target === 'ios' ? modules.slice(0, 2) : modules.slice(0, 1)
      for (const [name] of selected) download(name)
      return selected.map(metadata).join('\n')
    }
    assert.equal(args[1], '-m')
    return metadata(modules[2])
  }
  const output = join(root, 'assets', 'go-third-party.txt')
  assert.equal(collectGoLicenses(output, runGo), 3)
  assert.deepEqual(calls[0], ['android', 'mod', 'download', 'golang.org/x/mobile'])
  const text = readFileSync(output, 'utf8')
  for (const [name, version] of modules) {
    assert.ok(text.includes(`===== ${name} ${version} =====`))
    assert.ok(text.includes(`${name} 完整许可正文`))
  }
  assert.equal((text.match(/^===== /gm) ?? []).length, 3)
})

test('绑定运行时下载失败时停止，不生成不完整许可', () => {
  assert.throws(
    () =>
      collectGoLicenses('unused.txt', () => {
        throw new Error('下载失败')
      }),
    /下载失败/,
  )
})
