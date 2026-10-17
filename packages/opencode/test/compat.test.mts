import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { isVersionAtLeast } from '../../shared/src/min-version.mjs'
import { hostOpencodeExecutable, hostOpencodeVersion } from '../src/host-opencode.mjs'
import { versions } from '../src/versions.mjs'
import { assertResponse } from './schema.mjs'

// dist/opencode/test/ 往上四层是仓库根目录
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const ENTRY = fileURLToPath(new URL('../src/adapter.mjs', import.meta.url))

test('版本下限与已验证版本与 protocol/versions.json 的登记一致', () => {
  const registered = JSON.parse(readFileSync(join(ROOT, 'protocol/versions.json'), 'utf8'))
  assert.equal(versions.opencodeMinimum, registered.opencodeMinimum)
  assert.deepEqual([...versions.opencodeVerified], registered.opencodeVerified)
  assert.equal(versions.protocol, registered.codexProtocol)
  assert.ok(versions.opencodeVerified.every((v) => isVersionAtLeast(v, versions.opencodeMinimum)))
})

test('runtime/info 的扩展 schema 接受 OpenCode 的版本号，拒绝非法格式', () => {
  const info = {
    engine: 'opencode',
    protocolVersion: versions.protocol,
    nodeVersion: '24.14.0',
    cliBuild: '1.18.33',
    capabilities: ['submission.idempotency'],
    releaseReady: false,
  }
  assertResponse('runtime/info', info)
  for (const change of [{ cliBuild: 'latest' }, { nodeVersion: '24' }])
    assert.throws(() => assertResponse('runtime/info', { ...info, ...change }))
})

// 这三句话的开头是约定（设计文档 06 第四节）：设备层的诊断照开头认出“没装”“版本不对”“读不出版本”
test('找不到 OpenCode、版本过低、读不出版本时按约定的原文报错', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cha-opencode-cli-')))
  try {
    const missing = join(root, 'missing')
    assert.throws(
      () => hostOpencodeExecutable({ CHA_OPENCODE_CLI: missing, PATH: '', HOME: root }),
      /^Error: 宿主 OpenCode CLI 不可执行或未找到: .*CHA_OPENCODE_CLI/,
    )
    assert.throws(
      () => hostOpencodeExecutable({ PATH: root, HOME: root }),
      /宿主 OpenCode CLI 不可执行或未找到: opencode/,
    )
    const old = join(root, 'opencode')
    await writeFile(old, '#!/bin/sh\necho 1.17.9\n')
    await chmod(old, 0o755)
    assert.equal(hostOpencodeExecutable({ PATH: root, HOME: root }), old)
    assert.throws(
      () => hostOpencodeVersion(old, versions.opencodeMinimum),
      /^Error: 宿主 OpenCode CLI 版本不符: 需要 >= 1\.18\.0，实际 1\.17\.9/,
    )
    const broken = join(root, 'broken')
    await writeFile(broken, '#!/bin/sh\nexit 3\n')
    await chmod(broken, 0o755)
    assert.throws(
      () => hostOpencodeVersion(broken, versions.opencodeMinimum),
      /^Error: 无法读取宿主 OpenCode CLI 版本: /,
    )
    const fresh = join(root, 'fresh')
    await writeFile(fresh, '#!/bin/sh\necho 1.19.2\n')
    await chmod(fresh, 0o755)
    assert.equal(hostOpencodeVersion(fresh, versions.opencodeMinimum), '1.19.2')

    // 入口的 --runtime-info 把同样的话写到标准错误、退出码非零
    for (const [cli, expected] of [
      [missing, '宿主 OpenCode CLI 不可执行或未找到'],
      [old, '宿主 OpenCode CLI 版本不符'],
      [broken, '无法读取宿主 OpenCode CLI 版本'],
    ] as const) {
      let stderr = ''
      try {
        execFileSync(process.execPath, [ENTRY, '--runtime-info'], {
          env: { PATH: process.env.PATH, HOME: root, CHA_OPENCODE_CLI: cli },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        assert.fail('应当失败')
      } catch (error: any) {
        stderr = String(error.stderr)
        assert.equal(error.status, 1)
      }
      assert.ok(stderr.startsWith(expected), stderr)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('入口的 --version 和 --pty-self-check', () => {
  const version = execFileSync(process.execPath, [ENTRY, '--version'], { encoding: 'utf8' })
  assert.equal(version, `codex-cli ${versions.protocol} (codex-harness-adapter-opencode)\n`)
  const pty = execFileSync(process.execPath, [ENTRY, '--pty-self-check'], { encoding: 'utf8' })
  assert.equal(pty, 'pty-self-check ok\n')
})
