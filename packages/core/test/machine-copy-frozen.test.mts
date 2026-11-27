import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MACHINE_LIMITS } from '../../protocol/src/client-tools-machine.mjs'
import type { LookedPath, ToolKit } from '../src/device/machine/common.mjs'
import { copyTimeoutMs, freezeCopy, runFrozenCopy } from '../src/device/machine/copy-frozen.mjs'
import type { RunExit, Runner } from '../src/device/machine/runner.mjs'
import type { MachineTarget } from '../src/device/machine/types.mjs'
import { fakeClock } from './helpers.mjs'
import { fakeContext } from './machine-kit.test.mjs'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const POSIX = process.platform === 'darwin' || process.platform === 'linux'

test('冻结复制拒绝超限、文件内容和目标替换；成功时只发布已批准的字节', {
  skip: !POSIX,
}, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'litch-copy-test-')))
  t.after(async () => {
    await import('node:fs/promises').then(({ rm }) => rm(root, { recursive: true, force: true }))
  })
  const dir = join(root, 'dest')
  mkdirSync(dir)
  const sourceDir = join(root, 'source')
  mkdirSync(sourceDir)
  const data = Buffer.from([0, 9, 15, 22, 167, 1, 0, 86, 255, 75])
  const source = join(sourceDir, 'source.bin')
  const dest = join(dir, 'dest.bin')
  writeFileSync(source, data)
  let subprocesses = 0
  const runner: Runner = {
    async run(_target, argv, options) {
      subprocesses++
      const [file, ...args] = argv
      const child = spawn(file as string, args, {
        cwd: root,
        env: { HOME: root, PATH: '/bin:/usr/bin' },
      })
      const out: Buffer[] = []
      const err: Buffer[] = []
      child.stdout.on('data', (value) => out.push(value))
      child.stderr.on('data', (value) => err.push(value))
      child.stdin.on('error', () => {})
      if (!options.stdin) child.stdin.end()
      return {
        handle: String(child.pid),
        done: new Promise<RunExit>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code) => {
            const stdout = Buffer.concat(out)
            resolve({
              kind: 'exited',
              exitCode: code ?? 1,
              stdout,
              stderr: Buffer.concat(err),
              overflow: stdout.length > (options.collect ?? Infinity),
            })
          })
        }),
        kill: () => {
          child.stdin.destroy()
          child.kill('SIGTERM')
        },
        write: (bytes, end) =>
          new Promise((resolve, reject) => {
            const done = (error?: Error | null) => (error ? reject(error) : resolve())
            if (end) child.stdin.end(bytes, done)
            else child.stdin.write(bytes, done)
          }),
      }
    },
  }
  const { context } = fakeContext([])
  context.hashBytes = sha
  const kit: ToolKit = { context, runner, clock: fakeClock().clock, debug: () => {} }
  const endpoint = (role: 'desktop' | 'session', path: string, type: 'f' | 'm', size: number) => ({
    label: role,
    target: { id: role, role, facts: async () => ({ home: root }) } as MachineTarget,
    facts: {
      name: role,
      hostname: role,
      home: root,
      user: 'fixture',
      shell: '/bin/sh',
      system: process.platform === 'darwin' ? 'macOS' : 'Linux',
    },
    looked: {
      path,
      probe: { real: path, type, size, denied: [] },
      rules: [],
      blocked: null,
      icase: false,
    } satisfies LookedPath,
  })
  const from = endpoint('session', source, 'f', data.length)
  const to = endpoint('desktop', dest, 'm', 0)
  await assert.rejects(
    freezeCopy(kit, endpoint('session', source, 'f', MACHINE_LIMITS.deferredCopyBytes + 1), to, 8),
    /100 MiB/,
  )
  assert.equal(subprocesses, 0)
  const frozen = await freezeCopy(kit, from, to, 8)
  assert.match(frozen.details, /"overwrite": false/)
  assert.equal(frozen.hash, sha(data))
  assert.equal(existsSync(dest), false)
  const changed = Buffer.from(data)
  changed[0] = 42
  writeFileSync(source, changed)
  assert.notEqual((await freezeCopy(kit, from, to, 8)).fingerprint, frozen.fingerprint)
  await assert.rejects(runFrozenCopy(kit, from, to, frozen, 8), /approved source changed/)
  assert.equal(existsSync(dest), false)
  writeFileSync(source, data)
  const movedSource = join(root, 'moved-source')
  renameSync(sourceDir, movedSource)
  symlinkSync(movedSource, sourceDir)
  // 即使旧 inode 和 SHA-256 都相同，也不能通过被换成链接的父目录读取。
  await assert.rejects(freezeCopy(kit, from, to, 8))
  await assert.rejects(runFrozenCopy(kit, from, to, frozen, 8), /approved source changed/)
  renameSync(sourceDir, join(root, 'replaced-source'))
  renameSync(movedSource, sourceDir)
  renameSync(dir, join(root, 'previous'))
  mkdirSync(dir)
  assert.notEqual((await freezeCopy(kit, from, to, 8)).fingerprint, frozen.fingerprint)
  await assert.rejects(runFrozenCopy(kit, from, to, frozen, 8))
  assert.equal(existsSync(dest), false)
  symlinkSync(source, dest)
  await assert.rejects(freezeCopy(kit, from, endpoint('desktop', dest, 'f', data.length), 8))
  const final = join(dir, 'final.bin')
  const valid = endpoint('desktop', final, 'm', 0)
  const stage = (suffix: string, marker: string, expired: boolean) => {
    const path = join(dir, `.litch-copy.v1.${suffix}`)
    mkdirSync(path, { mode: 0o700 })
    writeFileSync(join(path, 'part'), 'residue')
    writeFileSync(join(path, 'owner'), marker)
    if (expired) {
      const time = new Date(Date.now() - 25 * 3_600_000)
      utimesSync(join(path, 'owner'), time, time)
    }
    return path
  }
  const expired = stage('OLDABC0001', 'Litch deferred copy v1', true)
  const ongoing = stage('CURABC0001', 'Litch deferred copy v1', false)
  const unrelated = stage('USRABC0001', 'user file', true)
  const legacy = join(dir, '.litch-copy.legacy')
  writeFileSync(legacy, 'unmarked')
  assert.equal(
    await runFrozenCopy(kit, from, valid, await freezeCopy(kit, from, valid, 8), 8),
    data.length,
  )
  assert.deepEqual(readFileSync(final), data)
  assert.equal(statSync(final).mode & 0o777, 0o666 & ~process.umask())
  assert.equal(existsSync(expired), false)
  assert.equal(readFileSync(join(ongoing, 'part'), 'utf8'), 'residue')
  assert.equal(readFileSync(join(unrelated, 'part'), 'utf8'), 'residue')
  assert.equal(readFileSync(legacy, 'utf8'), 'unmarked')

  writeFileSync(final, 'old')
  chmodSync(final, 0o751)
  const overwrite = endpoint('desktop', final, 'f', 3)
  assert.equal(
    await runFrozenCopy(kit, from, overwrite, await freezeCopy(kit, from, overwrite, 8), 8),
    data.length,
  )
  assert.deepEqual(readFileSync(final), data)
  assert.equal(statSync(final).mode & 0o777, 0o751)
})

test('复制运行时间随文件增长，100 MiB 留出 128 KiB/s 与 100 秒固定余量', () => {
  assert.equal(copyTimeoutMs(0), 100_000)
  assert.equal(copyTimeoutMs(MACHINE_LIMITS.deferredCopyBytes), 900_000)
  assert.ok(copyTimeoutMs(64 * 1024) < copyTimeoutMs(8 * 1024 ** 2))
})
