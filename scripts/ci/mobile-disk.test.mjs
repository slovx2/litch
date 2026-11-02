import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./mobile-disk.sh', import.meta.url))

for (const status of [0, 23]) {
  test(`手机分片磁盘清理：只移除预装工具，前后报告 df，保留退出码 ${status}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'litch-disk-test-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const events = join(root, 'events.jsonl')
    for (const command of ['df', 'sudo']) {
      writeFileSync(
        join(root, command),
        `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.EVENTS, JSON.stringify({command: ${JSON.stringify(command)}, args: process.argv.slice(2)}) + '\\n');
if (${JSON.stringify(command)} === 'sudo') process.exit(Number(process.env.CLEAN_STATUS));
console.log('Filesystem Size Used Avail');
`,
        { mode: 0o755 },
      )
    }
    const result = spawnSync('/bin/bash', [script], {
      env: { PATH: root, EVENTS: events, CLEAN_STATUS: String(status) },
      encoding: 'utf8',
    })
    assert.equal(result.status, status, result.stderr)
    const calls = readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(calls, [
      { command: 'df', args: ['-h', '/'] },
      {
        command: 'sudo',
        args: [
          'rm',
          '-rf',
          '/usr/share/dotnet',
          '/opt/ghc',
          '/usr/local/.ghcup',
          '/opt/hostedtoolcache/CodeQL',
          '/usr/local/share/powershell',
          '/usr/local/lib/node_modules',
        ],
      },
      { command: 'df', args: ['-h', '/'] },
    ])
    assert.equal(result.stdout.match(/Filesystem/g)?.length, 2)
  })
}

test('Full 的所有手机分片在工具安装、缓存恢复和模拟器启动之前清理磁盘', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/full.yml', import.meta.url),
    'utf8',
  )
  const mobile = workflow.split('\n  mobile:\n')[1].split(/^ {2}\S/m)[0]
  const cleanup = mobile.indexOf('run: bash scripts/ci/mobile-disk.sh')
  assert.ok(cleanup > mobile.indexOf('uses: actions/checkout@'))
  for (const stage of [
    'uses: actions/setup-node@',
    'uses: actions/cache@',
    'uses: reactivecircus/android-emulator-runner@',
  ])
    assert.ok(mobile.indexOf(stage) > cleanup, stage)
  assert.doesNotMatch(mobile.slice(mobile.indexOf('    steps:'), cleanup), /if:/)
  assert.doesNotMatch(mobile, /disk-size:|partition-size/)
})
