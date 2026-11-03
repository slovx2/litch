// 轮转游标和终态收据只影响扫描顺序，不参与恢复授权。每个来源仍经过完整账本校验。
import assert from 'node:assert/strict'
import { evidenceHash, workflowPaths } from './recovery-policy.mjs'

export const sourceFingerprint = (run) =>
  evidenceHash({
    id: run.id,
    sha: run.head_sha,
    attempt: run.run_attempt,
    status: run.status,
    conclusion: run.conclusion,
    updatedAt: run.updated_at,
  })

export function selectRecoveryBatch(
  runs,
  previous,
  { now = Date.now(), defaultBranch = 'main', limit = 5 } = {},
) {
  const state = previous ?? { cursor: 0, receipts: [] }
  assert.ok(Number.isSafeInteger(state.cursor) && state.cursor >= 0)
  assert.ok(Array.isArray(state.receipts) && state.receipts.length <= 2000)
  const receipts = new Map()
  for (const receipt of state.receipts) {
    assert.ok(Number.isSafeInteger(receipt.id) && receipt.id > 0)
    assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/)
    assert.equal(typeof receipt.terminal, 'boolean')
    assert.ok(Number.isFinite(Date.parse(receipt.seenAt)))
    assert.ok(!receipts.has(receipt.id))
    if (now - Date.parse(receipt.seenAt) <= 24 * 60 * 60_000) receipts.set(receipt.id, receipt)
  }
  const unique = new Map(runs.map((run) => [run.id, run]))
  assert.equal(unique.size, runs.length)
  const candidates = runs
    .filter((run) => {
      if (
        !workflowPaths.includes(run.path) ||
        run.head_branch !== defaultBranch ||
        run.repository?.full_name !== 'slovx2/litch' ||
        run.head_repository?.full_name !== 'slovx2/litch' ||
        run.status !== 'completed' ||
        (run.conclusion === 'success' && run.run_attempt !== 2)
      )
        return false
      const receipt = receipts.get(run.id)
      if (receipt?.terminal && receipt.fingerprint === sourceFingerprint(run)) return false
      const age = now - Date.parse(run.updated_at)
      // 待处理的deferred/uncertain超过两小时仍要看一次，以便明确记到期；不延长恢复窗口。
      return age >= 0 && (age <= 2 * 60 * 60_000 || (receipt && !receipt.terminal))
    })
    .sort((a, b) => a.id - b.id)
  const ordered = [
    ...candidates.filter((r) => r.id > state.cursor),
    ...candidates.filter((r) => r.id <= state.cursor),
  ]
  return {
    selected: ordered.slice(0, limit),
    remaining: ordered.slice(limit).map((r) => r.id),
    state: { cursor: state.cursor, receipts: [...receipts.values()] },
  }
}

export function recordScanned(state, run, result, now = Date.now()) {
  // 每个实际尝试都推进游标，包括未知错误；这样坏来源不能连续占住最前五个名额。
  const terminal =
    [
      'none',
      'aborted',
      'already-resolved',
      'recovery-completed',
      'recovery-verification-failed',
    ].includes(result.state) ||
    (result.state === 'blocked' &&
      ['recovery-window-expired', 'recovery-budget-unavailable'].includes(result.reason))
  const receipt = {
    id: run.id,
    fingerprint: sourceFingerprint(run),
    terminal,
    seenAt: new Date(now).toISOString(),
  }
  const receipts = [...state.receipts.filter((item) => item.id !== run.id), receipt]
  assert.ok(receipts.length <= 2000, '扫描收据超过上限，不静默丢弃')
  return { ...state, cursor: run.id, receipts }
}
