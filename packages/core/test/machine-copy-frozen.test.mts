import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { MACHINE_LIMITS } from '../../protocol/src/client-tools-machine.mjs'
import type { LookedPath, ToolKit } from '../src/device/machine/common.mjs'
import { freezeCopy, runFrozenCopy } from '../src/device/machine/copy-frozen.mjs'
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
  const data = Buffer.from([0, 9, 15, 22, 167, 1, 0, 86, 255, 75])
  const source = join(root, 'source.bin')
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
  renameSync(dir, join(root, 'previous'))
  mkdirSync(dir)
  assert.notEqual((await freezeCopy(kit, from, to, 8)).fingerprint, frozen.fingerprint)
  await assert.rejects(runFrozenCopy(kit, from, to, frozen, 8))
  assert.equal(existsSync(dest), false)
  symlinkSync(source, dest)
  await assert.rejects(freezeCopy(kit, from, endpoint('desktop', dest, 'f', data.length), 8))
  const final = join(dir, 'final.bin')
  const valid = endpoint('desktop', final, 'm', 0)
  assert.equal(
    await runFrozenCopy(kit, from, valid, await freezeCopy(kit, from, valid, 8), 8),
    data.length,
  )
  assert.deepEqual(readFileSync(final), data)
})
