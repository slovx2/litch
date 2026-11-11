import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installScript } from '../apps/desktop/src/ssh/script.mts'
import { build } from '../node_modules/esbuild/lib/main.js'

// 按桌面构建的路径映射载入正式解析器，不启动 Electron 或 SSH。
const compiled = await build({
  entryPoints: [new URL('../apps/desktop/src/ssh/upgrade.mts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
})
const { readInstall } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`
)

test('适配器检查直接载入探测源码，在隔离登录环境中找到安装的版本', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'litch-adapter-probe-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bin = join(root, '.local/bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'codex-harness-adapter'),
    '#!/bin/sh\ncase "$1" in version) echo "codex-harness-adapter 0.41.0";; device-proxy) exit 0;; *) exit 1;; esac\n',
    { mode: 0o755 },
  )
  const generated = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { probeScript } = await import(${JSON.stringify(new URL('../apps/desktop/src/ssh/script.mts', import.meta.url).href)}); console.log(JSON.stringify(probeScript()))`,
    ],
    {
      encoding: 'utf8',
      env: {
        HOME: root,
        PATH: '/usr/bin:/bin',
        LITCH_REMOTE_ADAPTER: 'codex-harness-adapter',
        LITCH_REMOTE_CODEX: join(root, 'uninstalled-codex'),
      },
    },
  )
  assert.equal(generated.status, 0, generated.stderr)
  const probe = JSON.parse(generated.stdout)
  const result = spawnSync('/bin/sh', [], {
    input: probe.text,
    encoding: 'utf8',
    env: { HOME: root, PATH: '/usr/bin:/bin', SHELL: '/bin/bash' },
  })
  assert.equal(result.status, 0, result.stderr)
  const answer = result.stdout.slice(result.stdout.indexOf(probe.marker))
  assert.match(answer, /^adapterVersion=codex-harness-adapter 0\.41\.0$/m)
  assert.match(answer, /^adapterRunning=yes$/m)
})

test('稳定标记在详情截断前解析，保留末尾输出；同一退出码的 curl 超时不误判', () => {
  const marker = 'LITCH_INSTALL_DISK_SPACE\t/home/dev path\t123456\t123'
  const tail = 'tar: follow-up error\n'.repeat(400)
  const result = readInstall({ step: 'install', code: '28', said: `${marker}\n${tail}` }, 'script')
  assert.deepEqual(result.diskSpace, {
    path: '/home/dev path',
    requiredKiB: 123456,
    availableKiB: 123,
  })
  assert.equal(result.said, tail.trim().slice(-4000))
  for (const at of ['download', 'install', 'brew', 'verify']) {
    const out = { step: at, code: '28', said: 'curl: (28) Operation timed out' }
    assert.deepEqual(readInstall(out, at === 'brew' ? 'brew' : 'script'), {
      ok: false,
      at,
      code: 28,
      said: out.said,
    })
  }
  for (const malformed of [
    marker.replace('123456', '-1'),
    marker.replace('123456', '999999999999999999'),
    marker.replace('123456', 'bad'),
  ]) {
    assert.equal(
      readInstall({ step: 'install', code: '28', said: malformed }, 'script').diskSpace,
      undefined,
    )
  }
  assert.deepEqual(
    readInstall(
      { step: 'verify', code: '0', installed: 'codex-harness-adapter 0.30.0', said: marker },
      'script',
    ),
    {
      ok: true,
      installed: '0.30.0',
      said: marker,
    },
  )
})

test('外层升级脚本在临时分区满时不下载，输出可解析空间快照', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'litch-remote-disk-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'home'))
  writeFileSync(
    join(root, 'df'),
    '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/disk 1000 1000 0 100%% /\\n"\n',
    { mode: 0o755 },
  )
  const script = installScript({ method: 'script', version: '0.30.0', lang: 'en' })
  const result = spawnSync('/bin/sh', [], {
    input: script.text,
    encoding: 'utf8',
    env: { HOME: join(root, 'home'), TMPDIR: root, PATH: `${root}:/usr/bin:/bin`, SHELL: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /step=download/)
  const out = Object.fromEntries(
    result.stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const at = line.indexOf('=')
        return [line.slice(0, at), line.slice(at + 1)]
      }),
  )
  assert.deepEqual(readInstall(out, 'script').diskSpace, {
    path: root,
    requiredKiB: 65536,
    availableKiB: 0,
  })
  // Linux root 的保留块足够时允许下载；下载仍用替身，不访问发布服务。
  writeFileSync(join(root, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 })
  writeFileSync(join(root, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 })
  writeFileSync(
    join(root, 'df'),
    '#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/disk 100000 1 0 100%% /\\n"\n',
    { mode: 0o755 },
  )
  writeFileSync(join(root, 'curl'), '#!/bin/sh\necho fixture-download >&2\nexit 22\n', {
    mode: 0o755,
  })
  const reserved = spawnSync('/bin/sh', [], {
    input: script.text,
    encoding: 'utf8',
    env: { HOME: join(root, 'home'), TMPDIR: root, PATH: `${root}:/usr/bin:/bin`, SHELL: '' },
  })
  assert.equal(reserved.status, 0, reserved.stderr)
  assert.match(reserved.stdout, /fixture-download/)
  assert.ok(!reserved.stdout.includes('LITCH_INSTALL_DISK_SPACE'))
})
