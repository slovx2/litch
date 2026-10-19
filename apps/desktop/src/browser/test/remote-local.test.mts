// 远端 localhost 转发的单元测试：网址怎么改写（纯函数）、转发器的复用、重起、撤掉、出错，
// 看门狗在我们这一头没了时结束 ssh，以及执行器接上之后给模型的说明。
// 用假的 ssh（一段 Node 脚本，照 -L 在回环上开个口子转到目标端口），不连任何机器；真 ssh 的那一遍在
// 远程端到端自检里（scripts/check-tools-remote.mjs）。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { RemoteTarget } from '@litch/core'
import type { ClientToolCallResponse } from '../../../../../packages/protocol/src/client-tools.mjs'
import type { ClientToolDevice, ClientToolInvocation } from '../../client-tools/types.mjs'
import { createForwarder, WATCHDOG } from '../../ssh/forward.mjs'
import { remoteLocalOf, remoteLocalResolver, rewriteTo } from '../../ssh/forward-url.mjs'
import { createBrowserExecutor } from '../executor.mjs'
import { createBrowserForwarding } from '../forwarding.mjs'
import type { BrowserHost, BrowserPage, TabInfo, TabOwner } from '../model.mjs'
import { createSiteBook } from '../sites.mjs'

// ---------- 假的 ssh ----------
// FAKE_SSH_DIR：每次被起记一份参数（args-<序号>.json）、进程号（pid-<本机端口>）；
// FAKE_SSH_MODE：ok 照常；auth 认证不过；bind-once 第一次报本机端口占不上
const FAKE = `
import { connect, createServer } from 'node:net'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = process.env.FAKE_SSH_DIR
const args = process.argv.slice(2)
writeFileSync(join(dir, 'args-' + Date.now() + '-' + process.pid + '.json'), JSON.stringify(args))
const spec = args[args.indexOf('-L') + 1]
const m = /^127\\.0\\.0\\.1:(\\d+):(\\[[^\\]]+\\]|[^:]+):(\\d+)$/.exec(spec)
if (!m) { console.error('bad -L ' + spec); process.exit(2) }
const local = Number(m[1]), host = m[2].replace(/^\\[|\\]$/g, ''), port = Number(m[3])
const mode = process.env.FAKE_SSH_MODE || 'ok'
if (mode === 'auth') { console.error('user@host: Permission denied (publickey).'); process.exit(255) }
const once = join(dir, 'bind-once')
if (mode === 'bind-once' && !existsSync(once)) {
  writeFileSync(once, '')
  console.error('bind [127.0.0.1]:' + local + ': Address already in use')
  console.error('Could not request local forwarding.')
  process.exit(255)
}
writeFileSync(join(dir, 'pid-' + local), String(process.pid))
const server = createServer((socket) => {
  const up = connect({ host, port })
  up.on('error', () => { console.error('channel 2: open failed: connect failed: Connection refused'); socket.destroy() })
  socket.on('error', () => up.destroy())
  up.on('connect', () => { socket.pipe(up); up.pipe(socket) })
})
server.on('error', (e) => { console.error('bind [127.0.0.1]:' + local + ': ' + e.message); console.error('Could not request local forwarding.'); process.exit(255) })
server.listen(local, '127.0.0.1')
process.on('SIGTERM', () => process.exit(0))
`

const work = mkdtempSync(join(tmpdir(), 'litch-forward-test-'))
const fakeJs = join(work, 'fake-ssh.mjs')
const fakeSsh = join(work, 'ssh')
writeFileSync(fakeJs, FAKE)
writeFileSync(
  fakeSsh,
  `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeJs)} "$@"\n`,
  {
    mode: 0o755,
  },
)
let dirSeq = 0
/** 每个用例一个记录目录，环境变量交给假 ssh（转发器起 ssh 用的是本进程的环境） */
function fakeDir(mode = 'ok') {
  const dir = join(work, `d${++dirSeq}`)
  mkdirSync(dir, { recursive: true })
  process.env.FAKE_SSH_DIR = dir
  process.env.FAKE_SSH_MODE = mode
  return {
    dir,
    spawns: () => readdirSync(dir).filter((name) => name.startsWith('args-')).length,
    args: () =>
      readdirSync(dir)
        .filter((name) => name.startsWith('args-'))
        .sort()
        .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as string[]),
    pid: (localPort: number) => Number(readFileSync(join(dir, `pid-${localPort}`), 'utf8')),
  }
}

const servers: Server[] = []
/** 一个“远端”的网页服务：回 Host 头 */
async function upstream(): Promise<number> {
  const server = createServer((req, res) => {
    res.end(`hello from ${req.url} host=${req.headers.host}`)
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return (server.address() as { port: number }).port
}
after(() => {
  for (const server of servers) server.close()
})

const get = async (port: number, path = '/') => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`)
  return response.text()
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (what: string, probe: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms
  while (!(await probe())) {
    if (Date.now() > end) throw new Error(`等不到：${what}`)
    await new Promise((done) => setTimeout(done, 50))
  }
}

const ALIAS: RemoteTarget = { kind: 'alias', alias: 'build' }

// ---------- 网址 ----------

test('哪些算远端本机地址、连远端的哪', () => {
  const of = (url: string) => remoteLocalOf(new URL(url))
  assert.deepEqual(of('http://localhost:3000/a'), { remoteHost: 'localhost', remotePort: 3000 })
  assert.deepEqual(of('http://127.0.0.1:3000/'), { remoteHost: 'localhost', remotePort: 3000 })
  assert.deepEqual(of('http://[::1]:3000/'), { remoteHost: 'localhost', remotePort: 3000 })
  assert.deepEqual(of('http://0.0.0.0:8080/'), { remoteHost: 'localhost', remotePort: 8080 })
  assert.deepEqual(of('http://app.localhost:5173/'), { remoteHost: 'localhost', remotePort: 5173 })
  assert.deepEqual(of('http://localhost/'), { remoteHost: 'localhost', remotePort: 80 })
  assert.deepEqual(of('https://localhost/'), { remoteHost: 'localhost', remotePort: 443 })
  assert.deepEqual(of('http://127.0.0.2:9000/'), { remoteHost: '127.0.0.2', remotePort: 9000 })
  assert.equal(of('https://example.com/'), null)
  assert.equal(of('http://192.168.1.2:3000/'), null)
  assert.equal(of('about:blank'), null)
})

test('改写只换主机和端口，路径、查询、片段不动', () => {
  const to = (url: string) => rewriteTo(new URL(url), 50123)
  assert.equal(to('http://localhost:3000/a/b?x=1#y'), 'http://localhost:50123/a/b?x=1#y')
  assert.equal(to('http://app.localhost:5173/'), 'http://app.localhost:50123/')
  assert.equal(to('http://127.0.0.1:3000/'), 'http://127.0.0.1:50123/')
  assert.equal(to('http://[::1]:3000/x'), 'http://127.0.0.1:50123/x')
  assert.equal(to('http://0.0.0.0:3000/'), 'http://127.0.0.1:50123/')
  assert.equal(to('https://localhost/'), 'https://localhost:50123/')
})

test('改写器：本机设备不动；远程设备起转发；已经是转发出来的地址不再转', async () => {
  const opened: Array<[string, string, number]> = []
  const running = new Map<number, { remoteHost: string; remotePort: number; running: boolean }>()
  const resolver = remoteLocalResolver(
    {
      async open(deviceId, remoteHost, remotePort) {
        opened.push([deviceId, remoteHost, remotePort])
        running.set(50000 + remotePort, { remoteHost, remotePort, running: true })
        return 50000 + remotePort
      },
      local: (deviceId, port) => {
        const hit = deviceId === 'build' ? running.get(port) : undefined
        return hit ? { ...hit, problem: null } : null
      },
      list: () => [],
      close() {},
    },
    (deviceId) => deviceId === 'build',
  )
  assert.equal(await resolver.resolve('http://localhost:3000/', 'local'), 'http://localhost:3000/')
  assert.equal(resolver.needs('http://localhost:3000/', 'local'), false)
  assert.equal(resolver.needs('https://example.com/', 'build'), false)
  assert.equal(await resolver.resolve('https://example.com/', 'build'), 'https://example.com/')
  assert.equal(resolver.needs('http://localhost:3000/', 'build'), true)
  assert.equal(
    await resolver.resolve('http://localhost:3000/a', 'build'),
    'http://localhost:53000/a',
  )
  assert.equal(await resolver.resolve('http://[::1]:3000/', 'build'), 'http://127.0.0.1:53000/')
  assert.deepEqual(opened, [
    ['build', 'localhost', 3000],
    ['build', 'localhost', 3000],
  ])
  // 抄回来的桌面地址：不再当成远端的 53000 转一次
  assert.equal(resolver.needs('http://localhost:53000/x', 'build'), false)
  assert.equal(
    await resolver.resolve('http://localhost:53000/x', 'build'),
    'http://localhost:53000/x',
  )
  assert.equal(opened.length, 2)
  // 转发没在跑：按原来的远端端口重起，地址不变
  ;(running.get(53000) as { running: boolean }).running = false
  assert.equal(resolver.needs('http://localhost:53000/x', 'build'), true)
  assert.equal(
    await resolver.resolve('http://localhost:53000/x', 'build'),
    'http://localhost:53000/x',
  )
  assert.deepEqual(opened.at(-1), ['build', 'localhost', 3000])
  const note = resolver.describe('http://localhost:53000/x', 'build') ?? ''
  assert.match(note, /remote device's localhost:3000, forwarded over ssh/)
  assert.equal(resolver.describe('http://localhost:53000/x', 'local'), null)
  assert.equal(resolver.describe('http://localhost:4000/', 'build'), null)
})

// ---------- 转发器（假 ssh） ----------

test('起转发：参数、只起一条、能连到远端、只在回环上', async () => {
  const fake = fakeDir()
  const remote = await upstream()
  process.env.LITCH_SSH_CONFIG = '/dev/null/fake-config'
  const forwarder = createForwarder({ targetOf: () => ALIAS, ssh: fakeSsh })
  try {
    const [a, b] = await Promise.all([
      forwarder.open('build', 'localhost', remote),
      forwarder.open('build', 'localhost', remote),
    ])
    assert.equal(a, b)
    assert.notEqual(a, remote)
    assert.equal(fake.spawns(), 1)
    assert.match(await get(a, '/hi'), /hello from \/hi host=127\.0\.0\.1:\d+/)
    const args = fake.args()[0] as string[]
    for (const want of [
      '-N',
      'ExitOnForwardFailure=yes',
      'ControlMaster=no',
      'ControlPath=none',
      'BatchMode=yes',
    ]) {
      assert.ok(args.includes(want), `参数里有 ${want}：${args.join(' ')}`)
    }
    assert.deepEqual(args.slice(0, 2), ['-F', '/dev/null/fake-config'])
    assert.equal(args[args.indexOf('-L') + 1], `127.0.0.1:${a}:localhost:${remote}`)
    assert.deepEqual(args.slice(-2), ['--', 'build'])
    // 第三次也复用
    assert.equal(await forwarder.open('build', 'localhost', remote), a)
    assert.equal(fake.spawns(), 1)
    // IPv6 的远端地址加方括号
    const v6 = await forwarder.open('build', '::1', remote)
    assert.equal(
      fake.args()[1]?.[(fake.args()[1] as string[]).indexOf('-L') + 1],
      `127.0.0.1:${v6}:[::1]:${remote}`,
    )
    assert.equal(forwarder.list().length, 2)
  } finally {
    forwarder.close()
    delete process.env.LITCH_SSH_CONFIG
  }
})

test('主机写法的目标：端口、密钥文件照设备配置传', async () => {
  const fake = fakeDir()
  const remote = await upstream()
  const forwarder = createForwarder({
    targetOf: () => ({ kind: 'host', host: 'h.example', port: 2222, user: 'me', keyFile: '/k/id' }),
    ssh: fakeSsh,
  })
  try {
    await forwarder.open('dev', 'localhost', remote)
    const args = fake.args()[0] as string[]
    assert.equal(args[args.indexOf('-p') + 1], '2222')
    assert.equal(args[args.indexOf('-i') + 1], '/k/id')
    assert.deepEqual(args.slice(-2), ['--', 'me@h.example'])
  } finally {
    forwarder.close()
  }
})

test('ssh 退了：还有标签在用就在原来的本机端口上重起', async () => {
  const fake = fakeDir()
  const remote = await upstream()
  const forwarder = createForwarder({ targetOf: () => ALIAS, ssh: fakeSsh, inUse: () => true })
  try {
    const port = await forwarder.open('build', 'localhost', remote)
    // 起来之后活过“很快就退”的线，免得被当成接连起不来；这里直接改时钟太绕，等一下就好
    const first = fake.pid(port)
    process.kill(first, 'SIGKILL')
    await until('重起', async () => {
      try {
        return fake.pid(port) !== first && (await get(port)).includes('hello')
      } catch {
        return false
      }
    })
    await until('又就绪', () => forwarder.local('build', port)?.running === true)
    assert.equal(fake.spawns(), 2)
  } finally {
    forwarder.close()
  }
})

test('接连起不来就不再自己重起；之后有人要时在原来的端口上从头起', async () => {
  const fake = fakeDir()
  const remote = await upstream()
  const forwarder = createForwarder({ targetOf: () => ALIAS, ssh: fakeSsh, inUse: () => true })
  try {
    const port = await forwarder.open('build', 'localhost', remote)
    // 让之后的每次都认证不过
    process.env.FAKE_SSH_MODE = 'auth'
    process.kill(fake.pid(port), 'SIGKILL')
    await until('放弃', () => forwarder.list().length === 0, 20_000)
    const spawned = fake.spawns()
    assert.ok(spawned >= 2 && spawned <= 5, `起了 ${spawned} 次`)
    // 撤掉了，但本机端口还记着：刷新那个地址时能认出来
    assert.deepEqual(forwarder.local('build', port), {
      remoteHost: 'localhost',
      remotePort: remote,
      running: false,
      problem: null,
    })
    await assert.rejects(forwarder.open('build', 'localhost', remote), /Permission denied/)
    assert.equal(forwarder.list().length, 0)
    process.env.FAKE_SSH_MODE = 'ok'
    assert.equal(await forwarder.open('build', 'localhost', remote), port)
  } finally {
    forwarder.close()
  }
})

test('认证不过：当场报 ssh 的原话，不留转发', async () => {
  fakeDir('auth')
  const forwarder = createForwarder({ targetOf: () => ALIAS, ssh: fakeSsh })
  await assert.rejects(
    forwarder.open('build', 'localhost', 3000),
    /Permission denied \(publickey\)/,
  )
  assert.equal(forwarder.list().length, 0)
  const none = createForwarder({ targetOf: () => null, ssh: fakeSsh })
  await assert.rejects(none.open('gone', 'localhost', 3000), /not an ssh device/)
})

test('本机端口没占上：换一个端口再起；记住的端口被别人占了也换', async () => {
  const fake = fakeDir('bind-once')
  const remote = await upstream()
  const file = join(fake.dir, 'forwards.json')
  const forwarder = createForwarder({ targetOf: () => ALIAS, ssh: fakeSsh, portsFile: file })
  const port = await forwarder.open('build', 'localhost', remote)
  assert.equal(fake.spawns(), 2)
  assert.match(await get(port), /hello/)
  forwarder.close()
  // 记在文件里：下一个转发器（应用重开）还用这个端口
  const again = createForwarder({ targetOf: () => ALIAS, ssh: fakeSsh, portsFile: file })
  await until('上一个 ssh 退干净', async () => !alive(fake.pid(port)))
  assert.equal(await again.open('build', 'localhost', remote), port)
  again.close()
  await until('又退干净', async () => !alive(fake.pid(port)))
  // 这个端口被别人占着
  const squatter = createTcpServer()
  await new Promise<void>((done) => squatter.listen(port, '127.0.0.1', done))
  const third = createForwarder({ targetOf: () => ALIAS, ssh: fakeSsh, portsFile: file })
  try {
    const other = await third.open('build', 'localhost', remote)
    assert.notEqual(other, port)
    assert.match(await get(other), /hello/)
  } finally {
    third.close()
    squatter.close()
  }
})

test('闲置、设备删掉、改了 ssh 目标都会撤掉；close 停掉进程', async () => {
  const fake = fakeDir()
  const remote = await upstream()
  let using = true
  let target: RemoteTarget | null = ALIAS
  const forwarder = createForwarder({
    targetOf: () => target,
    ssh: fakeSsh,
    inUse: () => using,
    idleMs: 100,
    sweepMs: 50,
  })
  const port = await forwarder.open('build', 'localhost', remote)
  await new Promise((done) => setTimeout(done, 300))
  assert.equal(forwarder.list().length, 1, '有标签在用时不撤')
  using = false
  await until('闲置撤掉', () => forwarder.list().length === 0)
  await until('ssh 退了', () => !alive(fake.pid(port)))

  using = true
  const again = await forwarder.open('build', 'localhost', remote)
  target = { kind: 'alias', alias: 'other' }
  await until('换了目标撤掉', () => forwarder.list().length === 0)
  await until('ssh 退了', () => !alive(fake.pid(again)))

  target = ALIAS
  const third = await forwarder.open('build', 'localhost', remote)
  target = null
  await until('设备删掉撤掉', () => forwarder.list().length === 0)
  await until('ssh 退了', () => !alive(fake.pid(third)))

  target = ALIAS
  const fourth = await forwarder.open('build', 'localhost', remote)
  forwarder.close()
  assert.equal(forwarder.list().length, 0)
  await until('close 之后 ssh 退了', () => !alive(fake.pid(fourth)))
})

test('看门狗：我们这头的管道断了（应用被强行结束）就结束 ssh', async () => {
  const fake = fakeDir()
  const remote = await upstream()
  const local = await new Promise<number>((done) => {
    const probe = createTcpServer()
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port
      probe.close(() => done(port))
    })
  })
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      WATCHDOG,
      'litch-forward',
      fakeSsh,
      '-N',
      '-L',
      `127.0.0.1:${local}:127.0.0.1:${remote}`,
    ],
    { stdio: ['pipe', 'ignore', 'ignore'], detached: true },
  )
  await until('假 ssh 起来', () => existsSync(join(fake.dir, `pid-${local}`)))
  await until('能连', async () => {
    try {
      return (await get(local)).includes('hello')
    } catch {
      return false
    }
  })
  const pid = fake.pid(local)
  // 外面那层 sh 被强行结束，我们这头的管道也断了：就像应用被强行退出
  process.kill(child.pid as number, 'SIGKILL')
  child.stdin?.destroy()
  await until('ssh 跟着退了', () => !alive(pid))
})

// ---------- 接到执行器上 ----------

function miniHost() {
  const pages = new Map<string, BrowserPage & { url: string; owner: TabOwner }>()
  let seq = 0
  const host: BrowserHost = {
    pages: () => [...pages.values()],
    page: (id) => pages.get(id),
    open(owner, kind) {
      const id = `t${++seq}`
      const page = {
        id,
        owner,
        url: 'about:blank',
        info: (): TabInfo => ({
          id,
          owner,
          kind,
          url: page.url,
          title: 'page',
          loading: false,
          canGoBack: false,
          canGoForward: false,
          agentActive: false,
          keep: false,
        }),
        async load(url: string) {
          page.url = url
          return { ok: true }
        },
        history: async () => ({ ok: true }),
        waitForLoad: async () => true,
        cdp: async <T,>() => ({}) as T,
        consoleEntries: () => [],
        clearConsole() {},
        dialog: () => null,
        dialogOpened: () => new Promise<never>(() => {}),
        takeNotices: () => [],
        setAgentActive() {},
        pointAt: async () => {},
      }
      pages.set(id, page)
      return page
    },
    close: (id) => void pages.delete(id),
    setKeep() {},
    release() {},
    show() {},
    setNavigationGate() {},
  }
  return host
}

test('执行器：远程会话的 navigate 经转发打开、结果里说明；本机会话不动', async () => {
  fakeDir()
  const remote = await upstream()
  const host = miniHost()
  const forwarding = createBrowserForwarding({
    targetOf: (deviceId) => (deviceId === 'build' ? ALIAS : null),
    tabs: () => host.pages().map((page) => page.info()),
    ssh: fakeSsh,
  })
  const executor = createBrowserExecutor({
    host,
    sites: createSiteBook(null),
    resolveUrl: forwarding.resolveUrl,
    describeUrl: forwarding.describeUrl,
  })
  const remoteDevice: ClientToolDevice = {
    id: 'build',
    name: 'build',
    kind: 'ssh',
    target: 'build',
  }
  const localDevice: ClientToolDevice = { id: 'local', name: 'Mac', kind: 'local', target: null }
  let seq = 0
  const run = (device: ClientToolDevice, tool: string, args: unknown) => {
    const invocation: ClientToolInvocation = {
      id: `i${++seq}`,
      threadId: 'a',
      turnId: 't1',
      callId: `c${seq}`,
      namespace: 'litch_browser',
      tool,
      arguments: args,
      device,
      harness: 'pi',
      cwd: null,
    }
    return executor.call(invocation, {
      signal: new AbortController().signal,
      ask: async () => null,
    })
  }
  const text = (reply: ClientToolCallResponse) =>
    reply.contentItems.map((item) => (item.type === 'inputText' ? item.text : '')).join('\n')
  try {
    const reply = await run(remoteDevice, 'navigate', { url: `http://localhost:${remote}/app` })
    assert.equal(reply.success, true, text(reply))
    const [forward] = forwarding.forwarder.list()
    assert.ok(forward)
    assert.match(text(reply), new RegExp(`localhost:${forward.localPort}/app`))
    assert.match(text(reply), new RegExp(`remote device's localhost:${remote}, forwarded over ssh`))
    assert.doesNotMatch(text(reply), /desktop's, not the remote machine's/)
    // 说明单独成段；同一个标签再操作时不重复，说法变了（下面 ssh 报了问题）才再说
    assert.match(text(reply), /\n\nNote: localhost:\d+ in this tab is the remote device's/)
    assert.doesNotMatch(
      text(await run(remoteDevice, 'navigate', { action: 'reload' })),
      /forwarded over ssh/,
    )
    // 远端那个端口上没人听：说明里带上 ssh 的原话
    const dead = await new Promise<number>((done) => {
      const probe = createTcpServer()
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as { port: number }).port
        probe.close(() => done(port))
      })
    })
    const refused = await run(remoteDevice, 'navigate', { url: `http://127.0.0.1:${dead}/` })
    assert.equal(refused.success, true, text(refused))
    const deadLocal = forwarding.forwarder.list().find((one) => one.remotePort === dead)?.localPort
    await until(
      'ssh 报通道打不开',
      () => !!forwarding.forwarder.local('build', deadLocal ?? -1)?.problem,
    )
    const again = await run(remoteDevice, 'navigate', { action: 'reload' })
    assert.match(
      text(again),
      /problem reaching localhost:\d+ on the remote device: .*open failed: connect failed/,
    )
    // 本机会话的 localhost 原样
    const local = await run(localDevice, 'navigate', { url: `http://localhost:${remote}/` })
    assert.match(text(local), new RegExp(`localhost:${remote}/`))
    assert.doesNotMatch(text(local), /forwarded/)
    assert.equal(forwarding.forwarder.list().length, 2)
  } finally {
    forwarding.close()
  }
})

test('同号转发（登录的 OAuth 回调）：本机端口就是远端端口；被占了不换，直接报错', async () => {
  fakeDir()
  // “远端”的服务开在 ::1 上，本机的 127.0.0.1 上同一个端口空着，转发占得上
  const server = createServer((req, res) => res.end(`callback ${req.url}`))
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '::1', done))
  const remote = (server.address() as { port: number }).port
  const forwarder = createForwarder({ targetOf: () => ALIAS, ssh: fakeSsh, samePort: true })
  try {
    assert.equal(await forwarder.open('build', '::1', remote), remote)
    assert.match(await get(remote, '/auth/callback?code=x'), /callback \/auth\/callback\?code=x/)
  } finally {
    forwarder.close()
  }
  // 本机这个端口被占着：不换端口，报出来
  const busy = await upstream()
  const strict = createForwarder({ targetOf: () => ALIAS, ssh: fakeSsh, samePort: true })
  try {
    await assert.rejects(
      strict.open('build', '::1', busy),
      /local port \d+ on 127\.0\.0\.1 is in use/,
    )
  } finally {
    strict.close()
  }
})
