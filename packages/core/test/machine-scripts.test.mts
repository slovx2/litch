// 执行器的小脚本在真的 sh 和系统工具上跑一遍（别的 machine-*.test.mts 用的是按脚本原文认的假机器，脚本本身没跑过）。
// macOS 上是 BSD 的工具，流水线的 Linux 上是 GNU 的，两边都要过。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { parseListed, parseProbe, scriptCommand } from '../src/device/machine/scripts.mjs'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'litch-machine-scripts-')))
after(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(root, 'dir'))
writeFileSync(join(root, 'dir', 'a.txt'), 'hello')
symlinkSync(join(root, 'dir'), join(root, 'link'))
symlinkSync(join(root, 'nowhere'), join(root, 'broken'))

const run = (command: string[], stdin?: string) => {
  const [file, ...args] = command
  const result = spawnSync(file as string, args, { input: stdin })
  assert.equal(result.status, 0, result.stderr.toString())
  return result.stdout
}
const probe = (path: string, denied: string[] = []) =>
  parseProbe(
    run(scriptCommand.probe(path, denied)).toString('utf8').split('\0').slice(0, -1),
    denied.length,
  )

test('probe：不存在的文件是 m，不会被当成它所在的目录', () => {
  const result = probe(join(root, 'dir', 'new.txt'))
  assert.equal(result.type, 'm')
  assert.equal(result.real, join(root, 'dir', 'new.txt'))
  // 隔了几层不存在的也一样
  assert.equal(probe(join(root, 'dir', 'x', 'y', 'z.txt')).type, 'm')
})

test('probe：文件、目录、断了的链接，以及经符号链接的真实路径', () => {
  assert.deepEqual(probe(join(root, 'dir', 'a.txt')), {
    real: join(root, 'dir', 'a.txt'),
    type: 'f',
    size: 5,
    denied: [],
  })
  assert.equal(probe(join(root, 'dir')).type, 'd')
  assert.equal(probe(join(root, 'broken')).type, 'l')
  const through = probe(join(root, 'link', 'a.txt'))
  assert.equal(through.type, 'f')
  assert.equal(through.real, join(root, 'dir', 'a.txt'))
  // 经链接、末尾不存在：真实路径接回不存在的那段
  const missing = probe(join(root, 'link', 'new.txt'))
  assert.equal(missing.type, 'm')
  assert.equal(missing.real, join(root, 'dir', 'new.txt'))
})

test('probe：禁止位置各解一个真实路径，不影响要看的那个', () => {
  const result = probe(join(root, 'dir', 'new.txt'), [join(root, 'link'), join(root, 'gone')])
  assert.equal(result.type, 'm')
  assert.deepEqual(result.denied, [join(root, 'dir'), join(root, 'gone')])
})

test('list、readRange、write、append', () => {
  const listed = run(scriptCommand.list(join(root, 'dir'), 1, false, []))
    .toString('utf8')
    .split(/[\0\x1e]/)
    .filter(Boolean)
    .map(parseListed)
  assert.deepEqual(
    listed.map((entry) => [entry?.type, entry?.size, entry?.path]),
    [['f', 5, join(root, 'dir', 'a.txt')]],
  )
  assert.equal(run(scriptCommand.readRange(join(root, 'dir', 'a.txt'), 1, 3)).toString(), 'ell')
  const file = join(root, 'dir', 'w.txt')
  run(scriptCommand.write(file), 'ab')
  run(scriptCommand.append(file), 'cd')
  assert.equal(run(scriptCommand.readRange(file, 0, 100)).toString(), 'abcd')
})
