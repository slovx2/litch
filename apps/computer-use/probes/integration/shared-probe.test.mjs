// 路径与真实内核锁合同；不启动 GUI、不触碰系统权限或用户钥匙串。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { acquireProbeBuildLock, probeAppPath } from './shared-probe.mjs'

test('默认产物独立于工作树与隔离 HOME；构建和运行覆盖必须一致', {
  skip: process.platform !== 'darwin',
}, () => {
  const expected =
    '/Users/test/Library/Application Support/Litch Tests/computer-use/Litch Background Input Probe.app'
  assert.equal(
    probeAppPath(undefined, { HOME: '/tmp/a', PWD: '/worktree/a' }, '/Users/test'),
    expected,
  )
  assert.equal(
    probeAppPath(undefined, { HOME: '/tmp/b', PWD: '/worktree/b' }, '/Users/test'),
    expected,
  )
  const other = '/shared/Litch Background Input Probe.app'
  assert.equal(probeAppPath(undefined, { LITCH_CU_PROBE_OUTPUT: other }), other)
  assert.equal(probeAppPath(undefined, { LITCH_CU_PROBE_APP: other }), other)
  assert.throws(() =>
    probeAppPath(undefined, { LITCH_CU_PROBE_APP: other, LITCH_CU_PROBE_OUTPUT: expected }),
  )
  assert.throws(() => probeAppPath('/Applications/Litch Computer Use.app', {}))
  assert.throws(() => probeAppPath(undefined, { LITCH_CU_PROBE_APP: './Probe.app' }))
})

test('并发构建互斥；释放后可重新构建', { skip: process.platform !== 'darwin' }, async () => {
  const directory = mkdtempSync('/tmp/litch-cu-build-lock-')
  const app = join(directory, 'Litch Background Input Probe.app')
  const release = await acquireProbeBuildLock(app)
  try {
    await assert.rejects(acquireProbeBuildLock(app), /探针正在运行或构建中/)
  } finally {
    await release()
  }
  const next = await acquireProbeBuildLock(app)
  await next()
  rmSync(directory, { recursive: true, force: true })
})

test('真实原生运行租约阻止重建；进程异常退出后内核释放锁', {
  skip: process.platform !== 'darwin',
}, async () => {
  const directory = mkdtempSync('/tmp/litch-cu-native-lock-')
  const app = join(directory, 'Litch Background Input Probe.app')
  const main = join(directory, 'main.swift')
  const binary = join(directory, 'lease')
  writeFileSync(
    main,
    'import Darwin\nlet lease = holdProbeLease(appPath: CommandLine.arguments[1])\nprint("leased")\nfflush(stdout)\nwhile true { sleep(1) }\n',
  )
  execFileSync('swiftc', [
    resolve(
      process.env.LITCH_DESKTOP_ROOT ?? 'apps/desktop',
      '../computer-use/probes/integration/ProbeLease.swift',
    ),
    main,
    '-o',
    binary,
  ])
  const native = spawn(binary, [app], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await once(native.stdout, 'data', { signal: AbortSignal.timeout(5000) })
    await assert.rejects(acquireProbeBuildLock(app), /探针正在运行或构建中/)
    const exit = once(native, 'exit')
    native.kill('SIGKILL')
    await exit
    const release = await acquireProbeBuildLock(app)
    try {
      const blocked = spawn(binary, [app], { stdio: 'ignore' })
      assert.equal((await once(blocked, 'exit'))[0], 75, '构建期间新探针不能进入运行状态')
    } finally {
      await release()
    }
  } finally {
    if (native.exitCode === null && native.signalCode === null) native.kill('SIGKILL')
    rmSync(directory, { recursive: true, force: true })
  }
})
