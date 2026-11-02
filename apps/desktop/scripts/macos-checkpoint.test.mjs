import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileHash } from '../../../scripts/ci/release-artifacts.mjs'
import { checkNotarization } from '../../../scripts/ci/release-candidate.mjs'
import {
  acceptedStep,
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
