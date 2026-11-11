// 正式手机脚本在隔离 shell 中运行；不需要手机私钥或个人 SSH 目录。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { firstInstallBody, installBlocked, installProbeBody } from '@litch/core'
import { parsePairs, setupScript } from '../src/platform/ssh-script.ts'

const token = '0123456789abcdef0123456789abcdef'
test('手机安装探测：Windows 不给按钮；没有 curl/wget 时明确指出原因，脚本同样拒绝下载', () => {
  const root = mkdtempSync(join(tmpdir(), 'litch-install-no-fetch-'))
  try {
    const command = (name, text) => {
      const at = join(root, name)
      writeFileSync(at, text)
      chmodSync(at, 0o755)
    }
    command('uname', '#!/bin/sh\necho Linux\n')
    for (const name of ['mkdir', 'sed', 'rm']) symlinkSync(`/bin/${name}`, join(root, name))
    // macOS 的 sed 在 /usr/bin。
    if (!existsSync(join(root, 'sed'))) {
      rmSync(join(root, 'sed'))
      symlinkSync('/usr/bin/sed', join(root, 'sed'))
    }
    const run = (body) =>
      parsePairs(
        execFileSync('/bin/sh', ['-c', body.join('\n')], {
          env: { PATH: root, TMPDIR: root },
          encoding: 'utf8',
        }),
      )
    assert.equal(installBlocked(run(installProbeBody)), 'fetch')
    const failed = run(firstInstallBody('download', token, '1.2.3', "'fixture-adapter'"))
    assert.equal(failed.step, 'fetch')
    assert.equal(failed.code, '127')
    assert.equal(existsSync(join(root, `litch-install-${token}`)), false, '失败后清理临时目录')
    command('uname', '#!/bin/sh\necho MINGW64_NT\n')
    assert.equal(installBlocked(run(installProbeBody)), 'system')
    const script = setupScript(
      { adapter: 'fixture-adapter', codex: 'fixture-codex', randomHex: () => token },
      'install',
      token,
      '1.2.3',
    )
    assert.match(script.text, /--version/)
    assert.match(script.text, /1\.2\.3/)
    assert.match(script.text, /litch-install-/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
