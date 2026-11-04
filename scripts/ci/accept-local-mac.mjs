import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { validateLocal } from './local-mac-remote.mjs'

const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH))
assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch')
assert.equal(process.env.LOCAL_MAC_REF_PROTECTED, 'true')
const envelope = JSON.parse(Buffer.from(event.inputs.envelope, 'base64').toString())
const payload = JSON.parse(envelope.payload)
const context = {
  repository: process.env.GITHUB_REPOSITORY,
  sha: process.env.GITHUB_SHA,
  runId: Number(event.inputs['source-run']),
}
validateLocal(envelope, process.env.LITCH_LOCAL_MAC_PUBLIC_KEY, context, payload.proof.plan.domains)
writeFileSync('local-mac-envelope.json', JSON.stringify(envelope))
appendFileSync(process.env.GITHUB_OUTPUT, `source=${context.runId}\n`)
