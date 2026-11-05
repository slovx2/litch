// 隔离 HOME、SSH 配置和真 sshd，验证普通端口与转发的主机钥匙。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'litch-pair-hostkey-'))
try {
  await build({
    entryPoints: [join(repo, 'apps/desktop/src/test/pair-hostkey.test.mts')],
    outfile: join(out, 'test.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    alias: { '@litch/core': join(repo, 'packages/core/src/index.mts') },
  })
  const container = process.argv[2]
  if (container) {
    const copy = spawnSync(
      'docker',
      ['cp', join(out, 'test.mjs'), `${container}:/tmp/pair-hostkey-test.mjs`],
      { stdio: 'inherit' },
    )
    if (copy.status !== 0) throw new Error('无法复制容器验收脚本')
  }
  const result = container
    ? spawnSync(
        'docker',
        [
          'exec',
          '-e',
          'HOME=/tmp/pair-home',
          '-e',
          'CODEX_HOME=/tmp/pair-codex',
          container,
          'node',
          '--test',
          '/tmp/pair-hostkey-test.mjs',
        ],
        { stdio: 'inherit' },
      )
    : spawnSync(process.execPath, ['--test', join(out, 'test.mjs')], {
        stdio: 'inherit',
        env: { ...process.env, HOME: out, CODEX_HOME: join(out, 'codex') },
      })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
