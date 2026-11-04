import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { findReceipt } from './local-mac-remote.mjs'

const context = {
  repository: process.env.GITHUB_REPOSITORY,
  sha: process.env.CANDIDATE_SHA,
  runId: Number(process.env.GITHUB_RUN_ID),
}
const selected = JSON.parse(process.env.NATIVE_DOMAINS)
const mode = process.argv[2]
const receipt = await findReceipt(context, selected)
if (mode === 'route') {
  const request = { ...context, attempt: Number(process.env.GITHUB_RUN_ATTEMPT), selected }
  writeFileSync('mac-native-request.json', JSON.stringify(request))
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `runner=${receipt ? 'ubuntu-24.04' : 'macos-15'}\nlocal=${Boolean(receipt)}\n`,
  )
} else {
  assert.equal(mode, 'import')
  assert.ok(receipt, '路由后的本地证明丢失或失效')
  // 新attempt中的job重新核验旧失败和签名，保留原始签名链；不修改原run的结论。
  const proof = {
    ...receipt.payload.proof,
    workflowSha: process.env.GITHUB_SHA,
    attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    localFallback: { envelope: receipt.envelope, artifact: receipt.artifact },
  }
  writeFileSync('mac-native-proof.json', JSON.stringify(proof))
}
