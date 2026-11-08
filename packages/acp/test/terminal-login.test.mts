import assert from 'node:assert/strict'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { AcpServer } from '../src/server.mjs'

const fake = `
import readline from 'node:readline'
const login = process.argv.includes('--login')
if (login) {
  if (process.env.FAKE_LOGIN_MODE === 'exit') process.exit(1)
  process.stdout.write('Open this link in a browser to log in with Google:\\nhttps://accounts.google.com/o/oauth2/auth?state=fake\\n')
  const input = readline.createInterface({ input: process.stdin })
  input.once('line', (value) => process.exit(value === 'good' ? 0 : 1))
} else {
  const input = readline.createInterface({ input: process.stdin })
  input.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: 1, agentCapabilities: { sessionCapabilities: { close: {}, list: {} }, auth: { logout: {} } },
        authMethods: [{ id: 'oauth-personal', name: 'Google', description: 'fake' }]
      } }) + '\\n')
    }
  })
}
`

async function server(mode?: string) {
  const root = await mkdtemp(join(tmpdir(), 'litch-agy-login-'))
  const cli = join(root, 'fake-agy.mjs')
  await writeFile(cli, fake, 'utf8')
  await chmod(cli, 0o700)
  const value = new AcpServer(root, {
    HOME: root,
    PATH: process.env.PATH,
    CHA_ACP_AGENT: 'agy',
    CHA_AGY_CLI: process.execPath,
    CHA_AGY_ARGS: cli,
    ...(mode ? { FAKE_LOGIN_MODE: mode } : {}),
  })
  await value.runtime.agent()
  return value
}

test('agy 终端登录：成功回填授权码', async () => {
  const value = await server()
  try {
    const login = await value.startTerminalLogin('oauth-personal')
    assert.match(login.url, /^https:\/\/accounts\.google\.com\//)
    await value.continueTerminalLogin(login.attemptId, 'good')
  } finally {
    await value.close()
  }
})

test('agy 终端登录：错误授权码失败，取消后 attempt 失效', async () => {
  const value = await server()
  try {
    const login = await value.startTerminalLogin('oauth-personal')
    await assert.rejects(value.continueTerminalLogin(login.attemptId, 'wrong'), /agy 登录失败/)
    const next = await value.startTerminalLogin('oauth-personal')
    value.cancelTerminalLogin(next.attemptId)
    await assert.rejects(value.continueTerminalLogin(next.attemptId, 'good'), /已失效/)
  } finally {
    await value.close()
  }
})

test('agy 终端登录：CLI 不能生成链接时立即失败', async () => {
  const value = await server('exit')
  try {
    await assert.rejects(value.startTerminalLogin('oauth-personal'), /agy 登录进程退出/)
  } finally {
    await value.close()
  }
})
