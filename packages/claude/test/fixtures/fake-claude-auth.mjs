#!/usr/bin/env node
// 假的 claude 命令，只认 `auth status|login|logout`，给 harness 详情设置的账号测试用，不碰钥匙串。
// 登录状态记在 $CLAUDE_CONFIG_DIR/fake-auth.json；每次被调用时把收到的几个环境变量记进 fake-calls.jsonl。
// 登录照真 CLI 的样子打一条手动授权链接、从标准输入读 `code#state`：good#state 成功，其余带 # 的失败，
// 不带 # 的说一句 Invalid code 接着等。
import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const dir = process.env.CLAUDE_CONFIG_DIR
const state = join(dir, 'fake-auth.json')
const args = process.argv.slice(2)
appendFileSync(
  join(dir, 'fake-calls.jsonl'),
  `${JSON.stringify({
    args,
    BROWSER: process.env.BROWSER ?? null,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  })}\n`,
)

function current() {
  try {
    return JSON.parse(readFileSync(state, 'utf8'))
  } catch {
    return null
  }
}

if (args[0] !== 'auth') process.exit(2)
if (args[1] === 'status') {
  const saved = current()
  const status = saved ?? {
    loggedIn: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
    authMethod: process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'oauth_token' : 'none',
    apiProvider: 'firstParty',
  }
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
  process.exit(status.loggedIn ? 0 : 1)
}
if (args[1] === 'logout') {
  rmSync(state, { force: true })
  process.stdout.write('Successfully logged out from your Anthropic account.\n')
  process.exit(0)
}
if (args[1] === 'login') {
  const mode = args.includes('--console') ? 'console' : 'claudeai'
  process.stdout.write('Opening browser to sign in…\n')
  process.stdout.write(
    `If the browser didn't open, visit: https://auth.example.test/oauth/authorize?code=true&mode=${mode}&state=abc\n`,
  )
  process.stdout.write('Paste code here if prompted > ')
  const lines = createInterface({ input: process.stdin })
  lines.on('line', (line) => {
    const [code, check] = line.trim().split('#')
    if (!code || !check) {
      process.stderr.write('Invalid code. Please make sure the full code was copied.\n')
      return
    }
    if (line.trim() === 'good#state') {
      writeFileSync(
        state,
        JSON.stringify(
          mode === 'console'
            ? {
                loggedIn: true,
                authMethod: 'api_key',
                apiKeySource: '/login managed key',
                email: 'dev@example.test',
                orgName: 'Example Org',
              }
            : {
                loggedIn: true,
                authMethod: 'claude.ai',
                email: 'dev@example.test',
                subscriptionType: 'max',
              },
        ),
      )
      process.stdout.write('Login successful.\n')
      process.exit(0)
    }
    process.stderr.write('Login failed: Request failed with status code 400\n')
    process.exit(1)
  })
} else process.exit(2)
