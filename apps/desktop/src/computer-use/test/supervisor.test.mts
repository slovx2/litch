// 看护与通道的单元测试：用一个说同样帧格式的假助手（Node 的 unix 套接字服务）代替真的应用。
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { MacLauncher, type MacLauncherOptions } from '../launcher-mac.mjs'
import { classifyApp } from '../policy.mjs'
import { FORBIDDEN_FOR_TEST } from '../policy-mac.mjs'
import { HelperSupervisor } from '../supervisor.mjs'
import { encodeFrame, FrameReader, HELPER_PROTOCOL, HelperError, MAX_FRAME } from '../wire.mjs'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
function tempDir(): string {
  // 套接字路径有长度上限，放在短的临时目录下
  const dir = mkdtempSync(join('/tmp', 'lcu-'))
  dirs.push(dir)
  return dir
}

/** macOS 的看护：启动器和看护分开之后，测试里还是一次给齐 */
function macSupervisor(options: MacLauncherOptions & { lang(): string }): HelperSupervisor {
  const { lang, ...launcher } = options
  return new HelperSupervisor({ launcher: new MacLauncher(launcher), lang })
}

interface FakeOptions {
  version: string
  bundlePath: string
  token: string | null
}

/** 假助手：认 hello（核对令牌）、permissions、shutdown；记下收到的方法 */
class FakeHelper {
  readonly server: Server
  readonly methods: string[] = []
  readonly sockets = new Set<Socket>()
  readonly path: string
  readonly options: FakeOptions
  constructor(path: string, options: FakeOptions) {
    this.path = path
    this.options = options
    this.server = createServer((socket) => this.serve(socket))
  }
  listen(): Promise<void> {
    return new Promise((resolve) => this.server.listen(this.path, resolve))
  }
  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }
  /** 模拟崩溃：连接全断、不再监听 */
  crash(): Promise<void> {
    return this.close()
  }
  private serve(socket: Socket): void {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    const reader = new FrameReader()
    socket.on('data', (data: Buffer) => {
      reader.push(data)
      for (let frame = reader.next(); frame !== undefined; frame = reader.next()) {
        const message = frame as { id: number; method: string; params: Record<string, unknown> }
        this.methods.push(message.method)
        const reply = (body: Record<string, unknown>) =>
          socket.write(encodeFrame({ jsonrpc: '2.0', id: message.id, ...body }))
        if (message.method === 'hello') {
          if (
            message.params.protocol !== HELPER_PROTOCOL ||
            message.params.token !== (this.options.token ?? undefined)
          ) {
            reply({
              error: {
                code: -32001,
                message: 'launch token missing or wrong',
                data: { kind: 'unauthorized' },
              },
            })
            socket.end()
            continue
          }
          reply({
            result: {
              protocol: HELPER_PROTOCOL,
              pid: 4242,
              version: this.options.version,
              bundleId: 'io.github.slovx2.litch.computer-use',
              bundlePath: this.options.bundlePath,
              auth: 'token',
              teamId: null,
            },
          })
        } else if (message.method === 'permissions') {
          reply({ result: { accessibility: false, screenRecording: true } })
        } else if (message.method === 'shutdown') {
          reply({ result: {} })
          setTimeout(() => void this.close(), 10)
        } else {
          reply({ error: { code: -32000, message: 'nope', data: { kind: 'notFound' } } })
        }
      }
    })
  }
}

test('帧编解码：分片、粘包、超限', () => {
  const reader = new FrameReader()
  const joined = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: '两帧' })])
  const got: unknown[] = []
  for (const byte of joined) {
    reader.push(Buffer.from([byte]))
    for (let frame = reader.next(); frame !== undefined; frame = reader.next()) got.push(frame)
  }
  assert.deepEqual(got, [{ a: 1 }, { b: '两帧' }])
  const big = new FrameReader()
  const head = Buffer.alloc(4)
  head.writeUInt32BE(MAX_FRAME + 1)
  big.push(head)
  assert.throws(() => big.next())
})

test('名单：助手底线名单里的每一项主进程这份都禁止；浏览器、终端算高风险', () => {
  for (const id of [
    'io.github.slovx2.litch',
    'io.github.slovx2.litch.computer-use',
    'com.apple.keychainaccess',
    'com.apple.Passwords',
    'com.apple.SecurityAgent',
    'com.apple.systempreferences',
    'com.1password.1password',
    'com.bitwarden.desktop',
  ]) {
    assert.equal(classifyApp({ platform: 'darwin', bundleId: id, name: 'x' }), 'forbidden', id)
  }
  assert.ok(FORBIDDEN_FOR_TEST.ids.size > 5)
  assert.equal(
    classifyApp({ platform: 'darwin', bundleId: 'com.google.Chrome.canary', name: 'Chrome' }),
    'elevated',
  )
  assert.equal(
    classifyApp({ platform: 'darwin', bundleId: 'com.apple.Terminal', name: 'Terminal' }),
    'elevated',
  )
  assert.equal(
    classifyApp({ platform: 'darwin', bundleId: 'com.example.vault', name: 'My Password Vault' }),
    'forbidden',
  )
  assert.equal(
    classifyApp({ platform: 'darwin', bundleId: 'com.apple.TextEdit', name: 'TextEdit' }),
    'normal',
  )
})

test('拉起：带一次性令牌握手；崩溃后自己重拉', async () => {
  const dir = tempDir()
  const socket = join(dir, 'helper.sock')
  const launches: Record<string, string>[] = []
  const fakes: FakeHelper[] = []
  const supervisor = macSupervisor({
    appPath: '/Apps/Litch Computer Use.app',
    directory: dir,
    version: '1.0.0',
    lang: () => 'zh-CN',
    launch: async (appPath, env) => {
      assert.equal(appPath, '/Apps/Litch Computer Use.app')
      launches.push(env)
      const fake = new FakeHelper(socket, {
        version: '1.0.0',
        bundlePath: '/Apps/Litch Computer Use.app',
        token: env.LITCH_COMPUTER_USE_TOKEN ?? null,
      })
      fakes.push(fake)
      await fake.listen()
    },
  })
  const client = await supervisor.client()
  assert.equal(client.hello?.pid, 4242)
  assert.equal(launches.length, 1)
  assert.equal(launches[0]?.LITCH_COMPUTER_USE_DIR, dir)
  assert.match(launches[0]?.LITCH_COMPUTER_USE_TOKEN ?? '', /^[0-9a-f]{64}$/)
  assert.deepEqual(await client.request('permissions'), {
    accessibility: false,
    screenRecording: true,
  })
  await assert.rejects(client.request('bogus'), (error: unknown) => {
    assert.ok(error instanceof HelperError)
    assert.equal(error.kind, 'notFound')
    return true
  })
  // 同一条连接复用，不重复拉起
  assert.equal(await supervisor.client(), client)

  await fakes[0]?.crash()
  // 退避 500 毫秒后重拉
  for (let i = 0; i < 40 && launches.length < 2; i += 1) await new Promise((r) => setTimeout(r, 50))
  assert.equal(launches.length, 2)
  assert.notEqual(launches[1]?.LITCH_COMPUTER_USE_TOKEN, launches[0]?.LITCH_COMPUTER_USE_TOKEN)
  for (let i = 0; i < 40 && !supervisor.connected; i += 1)
    await new Promise((r) => setTimeout(r, 50))
  assert.ok(supervisor.connected)
  await supervisor.dispose()
  assert.ok(fakes[1]?.methods.includes('shutdown'))
})

test('在跑的助手版本不对：请它退出，再拉起自己的', async () => {
  const dir = tempDir()
  const socket = join(dir, 'helper.sock')
  const old = new FakeHelper(socket, {
    version: '0.0.1',
    bundlePath: '/Old/Litch Computer Use.app',
    token: null,
  })
  await old.listen()
  let launched = 0
  const supervisor = macSupervisor({
    appPath: '/Apps/Litch Computer Use.app',
    directory: dir,
    version: '1.0.0',
    lang: () => 'en',
    launch: async (_appPath, env) => {
      launched += 1
      const fresh = new FakeHelper(socket, {
        version: '1.0.0',
        bundlePath: '/Apps/Litch Computer Use.app',
        token: env.LITCH_COMPUTER_USE_TOKEN ?? null,
      })
      await fresh.listen()
    },
  })
  const client = await supervisor.client()
  assert.deepEqual(old.methods, ['hello', 'shutdown'])
  assert.equal(launched, 1)
  assert.equal(client.hello?.version, '1.0.0')
  await supervisor.dispose()
})

test('在跑的助手不认这条连接（开发期令牌对不上）：按进程号文件结束它', async () => {
  const dir = tempDir()
  const socket = join(dir, 'helper.sock')
  const stale = new FakeHelper(socket, {
    version: '1.0.0',
    bundlePath: '/Apps/x.app',
    token: 'f'.repeat(64),
  })
  await stale.listen()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(dir, 'helper.pid'), '98765\n')
  const killed: number[] = []
  const supervisor = macSupervisor({
    appPath: '/Apps/x.app',
    directory: dir,
    version: null,
    lang: () => 'en',
    kill: (pid) => {
      killed.push(pid)
      void stale.close()
    },
    launch: async (_appPath, env) => {
      const fresh = new FakeHelper(socket, {
        version: '1.0.0',
        bundlePath: '/Apps/x.app',
        token: env.LITCH_COMPUTER_USE_TOKEN ?? null,
      })
      await fresh.listen()
    },
  })
  await supervisor.client()
  assert.deepEqual(killed, [98765])
  await supervisor.dispose()
})

test('套接字路径太长：直接报错，不拉起', async () => {
  const supervisor = macSupervisor({
    appPath: '/x.app',
    directory: `/tmp/${'很长的目录'.repeat(10)}`,
    version: null,
    lang: () => 'en',
    launch: async () => assert.fail('不该拉起'),
  })
  await assert.rejects(supervisor.client(), /socket path too long/)
})
