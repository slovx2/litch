import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileHash } from '../../../scripts/ci/release-artifacts.mjs'
import { checkNotarization } from '../../../scripts/ci/release-candidate.mjs'
import {
  acceptedStep,
  bindCheckpoint,
  checkCheckpoint,
  checkCheckpointJob,
  finishCheckpoint,
  hasAttemptedNotarization,
  uploadStep,
  verifyCheckpoint,
} from './macos-checkpoint.mjs'

test('公证步骤中途失败也不能在缺检查点时重新提交，未获 runner 不误拦', () => {
  const job = (conclusion) => [
    { name: 'desktop-macos', steps: [{ name: acceptedStep, conclusion }] },
  ]
  for (const conclusion of ['success', 'failure', 'cancelled', 'timed_out'])
    assert.equal(hasAttemptedNotarization(job(conclusion)), true)
  assert.equal(hasAttemptedNotarization(job('skipped')), false)
  assert.equal(hasAttemptedNotarization([{ name: 'desktop-macos', steps: [] }]), false)
})

const context = {
  repository: 'fixture/repo',
  sha: 'a'.repeat(40),
  run: '42',
  attempt: 3,
  version: '1.2.3',
  arch: 'arm64',
}
const proof = {
  schema: 1,
  state: 'Accepted',
  ...context,
  attempt: 1,
  submission: '12345678-1234-1234-1234-123456789abc',
  team: 'ABCDEFGHIJ',
  files: { 'signed-app.zip': 'b'.repeat(64), 'Litch-1.2.3-macos-arm64.dmg': 'c'.repeat(64) },
}

function bindFixture(t, outcomes) {
  const dir = mkdtempSync(join(tmpdir(), 'litch-checkpoint-bind-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const artifact = {
    id: 100,
    name: 'macos-notarized-3',
    digest: `sha256:${'b'.repeat(64)}`,
    expired: false,
    workflow_run: { id: 42, head_sha: context.sha },
  }
  const calls = [],
    waits = [],
    logs = []
  let clock = 0
  const options = {
    id: '100',
    digest: 'b'.repeat(64),
    execute(args, settings) {
      calls.push({ args, settings })
      const result = outcomes.shift() ?? artifact
      if (typeof result === 'number')
        throw Object.assign(new Error('gh api failed'), {
          status: 1,
          stderr: Buffer.from(`gh: fixture response (HTTP ${result})\n`),
        })
      if (result instanceof Error) throw result
      return JSON.stringify(result)
    },
    async sleep(ms) {
      waits.push(ms)
      clock += ms
    },
    now: () => clock,
    log: (message) => logs.push(message),
  }
  return {
    dir,
    artifact,
    options,
    calls,
    waits,
    logs,
    advance(ms) {
      clock += ms
    },
  }
}

test('新上传检查点：404 后有限退避成功，绑定原 ID 并保留摘要校验', async (t) => {
  const f = bindFixture(t, [404, 404])
  await bindCheckpoint(f.dir, context, f.options)
  assert.equal(f.calls.length, 3)
  assert.deepEqual(f.waits, [1000, 2000])
  assert.equal(f.logs.length, 2)
  for (const call of f.calls) {
    assert.deepEqual(call.args, ['api', 'repos/fixture/repo/actions/artifacts/100'])
    assert.deepEqual(call.settings, { timeout: 30_000, killSignal: 'SIGKILL' })
  }
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'source.json'))), {
    id: 100,
    name: f.artifact.name,
    digest: f.artifact.digest,
    attempt: 3,
  })
  const prefixed = bindFixture(t, [])
  await bindCheckpoint(prefixed.dir, context, {
    ...prefixed.options,
    digest: prefixed.artifact.digest,
  })
  assert.equal(prefixed.calls.length, 1)
})

test('新上传检查点：404 耗尽5次后硬失败，不生成绑定证明', async (t) => {
  const f = bindFixture(t, Array(5).fill(404))
  await assert.rejects(bindCheckpoint(f.dir, context, f.options), /gh api failed/)
  assert.equal(f.calls.length, 5)
  assert.deepEqual(f.waits, [1000, 2000, 4000, 8000])
  assert.equal(existsSync(join(f.dir, 'source.json')), false)
})

test('新上传检查点：其他4xx、5xx、超时及非HTTP错误立即失败', async (t) => {
  for (const outcome of [
    400,
    401,
    403,
    410,
    422,
    429,
    500,
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('404 in unrelated text'), {
      status: 404,
      stderr: 'unexpected failure',
    }),
  ]) {
    const f = bindFixture(t, [outcome])
    await assert.rejects(bindCheckpoint(f.dir, context, f.options))
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.waits, [])
    assert.equal(existsSync(join(f.dir, 'source.json')), false)
  }
})

test('新上传检查点：404 恢复后仍拒绝错误run、SHA、name、digest和expiry', async (t) => {
  for (const patch of [
    { workflow_run: { id: 43, head_sha: context.sha } },
    { workflow_run: { id: 42, head_sha: 'c'.repeat(40) } },
    { name: 'macos-notarized-2' },
    { digest: `sha256:${'c'.repeat(64)}` },
    { digest: '' },
    { expired: true },
  ]) {
    const outcomes = [404]
    const f = bindFixture(t, outcomes)
    outcomes.push({ ...f.artifact, ...patch })
    await assert.rejects(
      bindCheckpoint(f.dir, context, f.options),
      /artifact 来源、摘要、名字或有效期不符/,
    )
    assert.deepEqual(f.waits, [1000])
    assert.equal(f.calls.length, 2, '来源校验失败后不再重试')
    assert.equal(existsSync(join(f.dir, 'source.json')), false)
  }
})

test('bind 命令经隔离 gh 子进程读取404后恢复，生成同源绑定', (t) => {
  const f = bindFixture(t, [])
  const cli = new URL('./macos-checkpoint.mjs', import.meta.url)
  const fakeGh = join(f.dir, 'gh')
  writeFileSync(join(f.dir, 'package.json'), JSON.stringify({ version: context.version }))
  writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const log = path.join(process.env.HOME, 'requests.jsonl')
const previous = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''
fs.appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n')
if (!previous) { console.error('gh: Not Found (HTTP 404)'); process.exit(1) }
console.log(${JSON.stringify(JSON.stringify(f.artifact))})
`,
  )
  chmodSync(fakeGh, 0o755)
  execFileSync(process.execPath, [cli.pathname, 'bind', f.dir], {
    cwd: f.dir,
    timeout: 10_000,
    env: {
      PATH: [f.dir, dirname(process.execPath)].join(':'),
      HOME: f.dir,
      GITHUB_REPOSITORY: context.repository,
      CANDIDATE_SHA: context.sha,
      GITHUB_RUN_ID: context.run,
      GITHUB_RUN_ATTEMPT: String(context.attempt),
      CHECKPOINT_ID: '100',
      CHECKPOINT_DIGEST: 'b'.repeat(64),
    },
    stdio: 'pipe',
  })
  const calls = readFileSync(join(f.dir, 'requests.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse)
  assert.deepEqual(calls, Array(2).fill(['api', 'repos/fixture/repo/actions/artifacts/100']))
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'source.json'))), {
    id: 100,
    name: f.artifact.name,
    digest: f.artifact.digest,
    attempt: 3,
  })
})

test('新上传检查点：请求受剩余总预算限制，退避耗尽预算即停止', async (t) => {
  const f = bindFixture(t, [404])
  const execute = f.options.execute
  f.options.execute = (args, settings) => {
    if (!f.calls.length) f.advance(175_000)
    return execute(args, settings)
  }
  await bindCheckpoint(f.dir, context, f.options)
  assert.equal(f.calls[1].settings.timeout, 4000)
  const exhausted = bindFixture(t, [404])
  exhausted.options.sleep = async (ms) => {
    exhausted.waits.push(ms)
    exhausted.advance(180_000)
  }
  await assert.rejects(bindCheckpoint(exhausted.dir, context, exhausted.options), /超过3分钟/)
  assert.equal(exhausted.calls.length, 1)
  assert.equal(existsSync(join(exhausted.dir, 'source.json')), false)
})

test('检查点只认同源 Accepted，拒绝错 SHA/run/版本/架构/未来 attempt/无签名', () => {
  checkCheckpoint(proof, context)
  for (const patch of [
    { state: 'Rejected' },
    { sha: 'b'.repeat(40) },
    { run: '43' },
    { version: '1.2.4' },
    { arch: 'x64' },
    { attempt: 4 },
    { attempt: 0 },
    { team: '' },
    { submission: 'unknown' },
    { files: {} },
  ])
    assert.throws(() => checkCheckpoint({ ...proof, ...patch }, context))
})

test('恢复前逐文件验证 hash，损坏和文件丢失不能重新公证兜底', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-checkpoint-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const files = {}
  for (const name of Object.keys(proof.files)) {
    writeFileSync(join(dir, name), name)
    files[name] = await fileHash(join(dir, name))
  }
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify({ ...proof, files }))
  await verifyCheckpoint(dir, context)
  writeFileSync(join(dir, 'signed-app.zip'), 'tampered')
  await assert.rejects(verifyCheckpoint(dir, context), /hash/)
  rmSync(join(dir, 'signed-app.zip'))
  await assert.rejects(verifyCheckpoint(dir, context), /ENOENT/)
})

test('来源 job 可在票据失败后恢复，但 Accepted 和上传必须已成功', () => {
  const job = {
    id: 9,
    name: 'desktop-macos',
    run_attempt: 1,
    conclusion: 'failure',
    steps: [acceptedStep, uploadStep].map((name) => ({ name, conclusion: 'success' })),
  }
  assert.equal(checkCheckpointJob([job], 1), 9)
  assert.throws(() => checkCheckpointJob([job], 2))
  assert.throws(() => checkCheckpointJob([job, job], 1))
  for (const name of [acceptedStep, uploadStep])
    assert.throws(() =>
      checkCheckpointJob(
        [
          {
            ...job,
            steps: job.steps.map((s) => ({
              ...s,
              conclusion: s.name === name ? 'failure' : s.conclusion,
            })),
          },
        ],
        1,
      ),
    )
})

test('最终来源区分公证与票据 attempt，不能伪造本次重新公证或漏掉检查点', () => {
  const note = {
    ...proof,
    validatedAttempt: 3,
    artifact: {
      id: 100,
      name: 'macos-notarized-1',
      attempt: 1,
      digest: `sha256:${'b'.repeat(64)}`,
    },
  }
  const candidate = { ...context, runId: context.run }
  checkNotarization({ attempt: '3', notarization: note }, candidate)
  for (const patch of [
    { validatedAttempt: 1 },
    { attempt: 2 },
    { artifact: { ...note.artifact, name: 'desktop-macos-1' } },
  ])
    assert.throws(() =>
      checkNotarization({ attempt: '3', notarization: { ...note, ...patch } }, candidate),
    )
  assert.throws(() => checkNotarization({ attempt: '3' }, candidate))
})

test('恢复只查询原 Accepted，不重签/重提；查询或票据失败不生成最终证明', async (t) => {
  for (const outcome of ['success', 'Rejected', 'ticket-failure']) {
    const dir = mkdtempSync(join(tmpdir(), 'litch-checkpoint-finish-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    writeFileSync(
      join(dir, 'source.json'),
      JSON.stringify({ id: 100, attempt: 1, digest: `sha256:${'b'.repeat(64)}` }),
    )
    const calls = []
    const services = {
      restore: async () => ({ proof, app: 'Litch.app', dmg: 'Litch.dmg' }),
      execute: (command, args) => {
        calls.push([command, args])
        return JSON.stringify({
          id: proof.submission,
          status: outcome === 'Rejected' ? outcome : 'Accepted',
        })
      },
      stapleFile: (file) => {
        calls.push(['staple', [file]])
        if (outcome === 'ticket-failure') throw new Error('ticket failure')
      },
      summary: join(dir, 'summary.md'),
    }
    if (outcome === 'success') {
      await finishCheckpoint(dir, 'unused', context, services)
      assert.equal(JSON.parse(readFileSync(join(dir, 'validated.json'))).validatedAttempt, 3)
      assert.equal(calls.filter(([cmd]) => cmd === 'staple').length, 2)
    } else {
      await assert.rejects(finishCheckpoint(dir, 'unused', context, services))
      assert.equal(existsSync(join(dir, 'validated.json')), false)
      if (outcome === 'Rejected') assert.equal(calls.length, 1)
    }
    assert.deepEqual(
      calls.filter(([cmd]) => cmd === 'xcrun').map(([, args]) => args.slice(0, 3)),
      [['notarytool', 'info', proof.submission]],
    )
    assert.ok(calls.every(([cmd]) => cmd !== 'codesign'))
  }
})
