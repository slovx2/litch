import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { control } from '../src/controls.mjs'
import { AcpServer } from '../src/server.mjs'
import { TerminalLogin } from '../src/terminal-login.mjs'

// 照 agy 1.5.2 的 stdout 链接和 stdin 回填格式；只写隔离 HOME 的假状态。
const fake = `
import readline from 'node:readline'
import { existsSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const state = join(process.env.HOME, 'signed-in')
const log = join(process.env.HOME, 'commands')
appendFileSync(log, JSON.stringify(process.argv.slice(2))+'\\n')
if (process.argv.includes('--login')) {
  if (process.env.FAKE_LOGIN_MODE === 'exit') process.exit(1)
  if (process.env.FAKE_LOGIN_MODE === 'no-link') { setInterval(()=>{},1000) }
  else {
    process.stdout.write('Open this link in a browser to log in with Google:\\n\\n  https://accounts.google.com/o/oauth2/auth?')
    setTimeout(()=>process.stdout.write('state=fake\\n\\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\\n'),20)
    const input = readline.createInterface({ input: process.stdin })
    input.once('line', (value) => {
      if (process.env.FAKE_LOGIN_MODE === 'wait') { setInterval(()=>{},1000); return }
      if (['good','https://antigravity.google/oauth-callback?code=good'].includes(value)) {
        writeFileSync(state,'fake'); process.exit(0)
      }
      process.stderr.write('invalid authorization code\\n'); process.exit(1)
    })
  }
} else {
  const input = readline.createInterface({ input: process.stdin })
  input.on('line', (line) => {
    const m = JSON.parse(line)
    appendFileSync(log,m.method+'\\n')
    let result, error
    if (m.method === 'initialize') result = {
      protocolVersion: 1, agentCapabilities: { sessionCapabilities: { list: {} } },
      authMethods: ['oauth-personal','oauth-business'].map(id=>({id,name:id}))
    }
    else if (m.method === 'session/list') {
      if (existsSync(state)) result = { sessions: [] }
      else error = { code: -32000, message: 'Authentication required' }
    } else error = { code: -32601, message: 'unexpected request' }
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...(error ? {error} : {result})})+'\\n')
  })
}
`

async function fixture(mode = '', browser = '') {
  const root = await mkdtemp(join(tmpdir(), 'litch-agy-login-'))
  const cli = join(root, 'fake-agy.mjs')
  await writeFile(cli, fake)
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    BROWSER: browser,
    CHA_ACP_AGENT: 'agy',
    CHA_AGY_CLI: process.execPath,
    CHA_AGY_ARGS: `"${cli}" acp`,
    FAKE_LOGIN_MODE: mode,
  }
  return {
    root,
    env,
    spawn: () =>
      spawn(process.execPath, [cli, 'acp', '--login'], { env, stdio: ['pipe', 'pipe', 'pipe'] }),
  }
}

for (const browser of ['', '/fake/desktop-browser'])
  test(`agy 登录不依赖设备浏览器（${browser ? '已配置' : '无浏览器'}）：复制链接、回填后自动可读状态`, async () => {
    const f = await fixture('', browser)
    const server = new AcpServer(f.root, f.env)
    try {
      const before = (await control(server, 'litch/acp/auth/read', {})) as any
      assert.equal(before.status, 'signedOut')
      assert.deepEqual(
        before.methods.map((m: any) => m.id),
        ['oauth-personal'],
      )
      const { login } = (await control(server, 'litch/acp/auth/authenticate', {
        methodId: 'oauth-personal',
      })) as any
      assert.equal(login.url, 'https://accounts.google.com/o/oauth2/auth?state=fake')
      await control(server, 'litch/acp/auth/continue', {
        attemptId: login.attemptId,
        authorizationCode: 'https://antigravity.google/oauth-callback?code=good',
      })
      assert.equal(((await control(server, 'litch/acp/auth/read', {})) as any).status, 'signedIn')
      await assert.rejects(
        control(server, 'litch/acp/auth/authenticate', { methodId: 'oauth-business' }),
        /仅支持/,
      )
      const commands = await readFile(join(f.root, 'commands'), 'utf8')
      assert.match(commands, /\["acp","--login"\]/)
      assert.doesNotMatch(commands, /^authenticate$/m)
    } finally {
      await server.close()
    }
  })

test('授权码错误：释放 attempt，允许重新登录', async () => {
  const f = await fixture()
  const flow = new TerminalLogin(f.spawn)
  try {
    const login = await flow.start()
    await assert.rejects(flow.submit(login.attemptId, 'wrong'), /agy 登录失败/)
    const next = await flow.start()
    await flow.submit(next.attemptId, 'good')
  } finally {
    flow.close()
  }
})

test('用户取消：等待回填与提交期间都可取消，不残留进行中的 attempt', async () => {
  const f = await fixture('wait')
  const flow = new TerminalLogin(f.spawn)
  try {
    const login = await flow.start()
    flow.cancel(login.attemptId)
    await assert.rejects(flow.submit(login.attemptId, 'good'), /已失效/)
    const next = await flow.start()
    const submitted = flow.submit(next.attemptId, 'good')
    flow.cancel(next.attemptId)
    await assert.rejects(submitted, /已取消/)
  } finally {
    flow.close()
  }
})

for (const [mode, stage] of [
  ['no-link', '生成'],
  ['', '回填'],
  ['wait', '提交'],
])
  test(`超时：${stage}阶段清理进程并允许下一次登录`, async () => {
    const f = await fixture(mode)
    const flow = new TerminalLogin(f.spawn, {
      linkMs: mode === 'no-link' ? 150 : 5000,
      inputMs: 100,
      submitMs: 100,
    })
    try {
      if (mode === 'no-link') await assert.rejects(flow.start(), /生成超时/)
      else {
        const login = await flow.start()
        if (mode === 'wait') await assert.rejects(flow.submit(login.attemptId, 'good'), /等待超时/)
        else {
          await new Promise((resolve) => setTimeout(resolve, 200))
          await assert.rejects(flow.submit(login.attemptId, 'good'), /已失效/)
        }
      }
      // 没有卡在“已有登录正在进行”。
      if (mode === 'no-link') await assert.rejects(flow.start(), /生成超时/)
      else {
        const next = await flow.start()
        flow.cancel(next.attemptId)
      }
    } finally {
      flow.close()
    }
  })

test('CLI 未返回链接即退出：立即失败，不遗留轮询计时器', async () => {
  const f = await fixture('exit')
  const flow = new TerminalLogin(f.spawn)
  await assert.rejects(flow.start(), /agy 登录失败/)
})
