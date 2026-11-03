// 仅由 Windows 原生检查入口执行；误在其他平台运行必须失败。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { cleanReal, inside } from '../src/device/machine/paths.mjs'
import { parseListed, parseProbe } from '../src/device/machine/scripts.mjs'
import { windowsExec, windowsScripts } from '../src/device/machine/scripts-windows.mjs'
import { windowsShortPath } from './machine-windows-fixture.mjs'

assert.equal(process.platform, 'win32', 'Windows 原生用例必须在 Windows 上执行')

test('Windows 真脚本：中文、字节范围、追加、junction、目录裁剪和命令退出码', () => {
  const root = mkdtempSync(join(tmpdir(), 'litch-machine-中文 '))
  const run = (argv: string[], input?: Buffer): Buffer => {
    const result = spawnSync(argv[0] as string, argv.slice(1), {
      input,
      windowsHide: true,
      timeout: 30_000,
    })
    assert.equal(result.status, 0, result.stderr?.toString() || String(result.error))
    return result.stdout
  }
  const probe = (path: string, denied: string[] = []) =>
    parseProbe(
      run(windowsScripts.probe(path, denied)).toString('utf8').split('\0').slice(0, -1),
      denied.length,
    )
  try {
    mkdirSync(join(root, '机密'))
    writeFileSync(join(root, '机密', '凭据.txt'), '不要泄露')
    symlinkSync(join(root, '机密'), join(root, '联接'), 'junction')
    const resolved = probe(join(root, '联接', '凭据.txt'), [join(root, '机密')])
    assert.equal(resolved.type, 'f')
    assert.equal(resolved.size, Buffer.byteLength('不要泄露'))
    assert.equal(inside(resolved.denied[0] as string, resolved.real, true), true)
    assert.equal(probe(join(root, '联接', '不存在', '新文件')).type, 'm')
    const file = join(root, "a'中文.txt")
    run(windowsScripts.write(file), Buffer.from('中文\r\n'))
    run(windowsScripts.append(file), Buffer.from('追加\n'))
    assert.deepEqual(readFileSync(file), Buffer.from('中文\r\n追加\n'))
    assert.deepEqual(run(windowsScripts.readRange(file, 3, 5)), Buffer.from('文\r\n'))
    const rows = run(windowsScripts.list(root, null, true, [cleanReal(join(root, '机密'))]))
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map(parseListed)
    assert.ok(rows.some((one) => one?.type === 'l'))
    assert.equal(
      rows.some((one) => one?.path.endsWith('/凭据.txt')),
      false,
    )
    assert.match(run(windowsExec("Write-Output '中文输出😀'")).toString('utf8'), /中文输出😀/)
    assert.equal(spawnSync(...commandTuple(windowsExec('exit 7')), { windowsHide: true }).status, 7)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const commandTuple = (argv: string[]): [string, string[]] => [argv[0] as string, argv.slice(1)]

test('Windows 真实别名：短名、大小写与 junction 规则都裁剪同一目录，边界相邻目录仍可读', () => {
  const root = mkdtempSync(join(tmpdir(), 'litch-machine-alias-long '))
  const secret = join(root, 'Confidential Directory')
  const sibling = join(root, 'Confidential Directory-other')
  const alias = join(root, 'Secret Junction')
  try {
    mkdirSync(secret)
    mkdirSync(sibling)
    writeFileSync(join(secret, 'credential.txt'), 'fixture-secret')
    writeFileSync(join(sibling, 'public.txt'), 'fixture-public')
    symlinkSync(secret, alias, 'junction')
    const shortRoot = windowsShortPath(root)
    const shortSecret = windowsShortPath(secret)
    for (const [directory, rule] of [
      [root, secret],
      [root, shortSecret],
      [shortRoot, shortSecret.toLowerCase()],
      [shortRoot.toUpperCase(), alias],
    ] as const) {
      const argv = windowsScripts.list(directory, null, true, [rule])
      const result = spawnSync(argv[0] as string, argv.slice(1), {
        windowsHide: true,
        timeout: 30_000,
      })
      assert.equal(result.status, 0, result.stderr?.toString() || String(result.error))
      const rows = result.stdout.toString('utf8').split('\0').filter(Boolean).map(parseListed)
      assert.ok(
        rows.some((entry) => entry?.path.endsWith('/public.txt')),
        `${directory}: 边界相邻目录`,
      )
      assert.ok(
        !rows.some((entry) => entry?.path.endsWith('/credential.txt')),
        `${directory} / ${rule}: 禁止目录被遍历`,
      )
      assert.ok(
        rows.some((entry) => entry?.type === 'l' && entry.path.endsWith('/Secret Junction')),
      )
    }
    // 从禁止目录的另一个别名直接起列举，也不能绕过底层裁剪。
    const argv = windowsScripts.list(alias, null, true, [shortSecret])
    const result = spawnSync(argv[0] as string, argv.slice(1), {
      windowsHide: true,
      timeout: 30_000,
    })
    assert.equal(result.status, 0, result.stderr?.toString() || String(result.error))
    assert.equal(result.stdout.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
