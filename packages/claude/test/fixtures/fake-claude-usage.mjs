#!/usr/bin/env node
// 假的 claude 命令，只答 SDK 的两个控制请求：initialize 和 get_usage（账号额度），给额度的用例用，不碰钥匙串。
// get_usage 的回答每次现读 $CLAUDE_CONFIG_DIR/fake-usage.json（用例中途可以改），
// 每收到一次 get_usage 往 fake-usage-calls.jsonl 记一行（带上请求里的 skip_behaviors）。
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.env.CLAUDE_CONFIG_DIR
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.282 (Claude Code)\n')
  process.exit(0)
}

const reply = (requestId, response) =>
  process.stdout.write(
    `${JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    })}\n`,
  )

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message?.type !== 'control_request') return
  const request = message.request ?? {}
  if (request.subtype === 'initialize') {
    reply(message.request_id, {
      commands: [],
      agents: [],
      output_style: 'default',
      available_output_styles: ['default'],
      models: [],
      account: {},
    })
    return
  }
  if (request.subtype === 'get_usage') {
    appendFileSync(
      join(dir, 'fake-usage-calls.jsonl'),
      `${JSON.stringify({ skip_behaviors: request.skip_behaviors ?? null })}\n`,
    )
    const usage = JSON.parse(readFileSync(join(dir, 'fake-usage.json'), 'utf8'))
    reply(message.request_id, {
      session: {
        total_cost_usd: 0,
        total_api_duration_ms: 0,
        total_duration_ms: 0,
        total_lines_added: 0,
        total_lines_removed: 0,
        model_usage: {},
      },
      behaviors: null,
      ...usage,
    })
    return
  }
  process.stdout.write(
    `${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: message.request_id,
        error: `fake claude: ${request.subtype}`,
      },
    })}\n`,
  )
})
