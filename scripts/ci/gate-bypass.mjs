// 单人维护的手动决定只记录原因，不生成虚假的成功检查证明。
import assert from 'node:assert/strict'

export function bypassReason(env = process.env) {
  if (env.BYPASS_GATE !== 'true') return null
  const reason = (env.BYPASS_REASON ?? '').trim()
  assert.ok(reason, '开启 bypass-gate 必须填写 bypass-reason')
  return reason
}

export function gateBypass(context, env = process.env) {
  const reason = bypassReason(env)
  assert.ok(reason, '未开启手动绕过')
  assert.ok(env.GITHUB_ACTOR, '缺少手动绕过操作者')
  return {
    repository: context.repository,
    sha: context.sha,
    run: String(context.runId),
    attempt: String(context.attempt),
    mode: env.RELEASE_MODE || 'standard',
    conclusion: 'bypassed',
    bypass: { reason, actor: env.GITHUB_ACTOR },
    createdAt: new Date().toISOString(),
  }
}

export function checkBypass(gate, context) {
  assert.equal(gate.conclusion, 'bypassed')
  for (const [key, expected] of Object.entries({
    repository: context.repository,
    sha: context.sha,
    run: String(context.runId),
  }))
    assert.equal(gate[key], expected, `手动绕过 ${key} 不符`)
  assert.ok(['standard', 'patch'].includes(gate.mode), '未知发版模式')
  assert.ok(/^[1-9][0-9]*$/.test(gate.attempt) && Number(gate.attempt) <= Number(context.attempt))
  assert.ok(typeof gate.bypass?.reason === 'string' && gate.bypass.reason.trim(), '缺少绕过原因')
  assert.ok(typeof gate.bypass.actor === 'string' && gate.bypass.actor.trim(), '缺少绕过操作者')
  assert.ok(Number.isFinite(Date.parse(gate.createdAt)), '缺少绕过时间')
}
