import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { startWebSocketTransport } from '../../shared/src/transports.mjs'
import { DeviceServer } from '../src/device.mjs'
import { listenUnix, unixConnector } from '../src/sockets.mjs'
import { assertRuntimeInfo, settle, TestClient, tempDir } from './helpers.mjs'

const text = (base64: string) => Buffer.from(base64, 'base64').toString('utf8')
const base64 = (value: string) => Buffer.from(value).toString('base64')

/**
 * 一个真的在 unix 套接字上监听的上游，用的是运行时自己那份监听代码（packages/shared），
 * 这样聚合面连它走的就是连真实运行时的那条路。只会握手和报自己是谁。
 */
function runtimeOn(path: string, engine: string) {
  const calls: string[] = []
  return startWebSocketTransport(
    `unix://${path}`,
    (peer, message) => {
      if (!('method' in message)) return
      calls.push(message.method)
      if (!('id' in message)) return
      const result =
        message.method === 'initialize'
          ? { userAgent: 'rt/0.163.0', codexHome: '/', platformFamily: 'unix', platformOs: 'test' }
          : message.method === 'runtime/info'
            ? {
                engine,
                protocolVersion: '0.163.0',
                cliBuild: '3.2.1',
                capabilities: [],
                releaseReady: false,
              }
            : message.method === 'thread/list'
              ? {
                  data: [{ id: `${engine}-1`, updatedAt: 1 }],
                  nextCursor: null,
                  backwardsCursor: null,
                }
              : null
      if (result) peer.send({ jsonrpc: '2.0', id: message.id, result })
      else peer.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: '没有' } })
    },
    () => {},
  ).then((transport) => ({ transport, calls }))
}

test('聚合面的套接字：只有属主可读写，不抢别的进程正在听的，留下的死文件会换掉', async () => {
  const root = tempDir()
  const path = join(root, 'device', 'device.sock')
  const device = new DeviceServer({ stateDir: join(root, 'device'), upstreams: [] })
  try {
    writeFileSync(join(root, 'before'), '')
    const listener = await listenUnix(path, (wire) => device.attach(wire))
    assert.equal(statSync(path).mode & 0o777, 0o600)
    // 监听之后进程的 umask 没有被改掉：经 fs/* 写的文件、开的终端里建的文件，权限和监听之前一样
    writeFileSync(join(root, 'after'), '')
    assert.equal(statSync(join(root, 'after')).mode, statSync(join(root, 'before')).mode)
    await assert.rejects(
      listenUnix(path, (wire) => device.attach(wire)),
      /已经有进程在监听/,
    )
    // 没有上游也能握手，harness 列表是空的
    const client = await TestClient.overSocket(path)
    await client.initialize()
    assert.deepEqual((await client.call('runtime/info')).harnesses, [])
    client.close()
    await listener.close()
    assert.equal(existsSync(path), false)

    // 上一个进程没来得及清掉的文件：没有人在听，换掉
    writeFileSync(path, '')
    const again = await listenUnix(path, (wire) => device.attach(wire))
    assert.equal(statSync(path).isSocket(), true)
    await again.close()
  } finally {
    await device.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('经真的套接字：连上用运行时监听代码起的上游，设备级的文件、终端、找文件都由设备层处理', async () => {
  const root = tempDir()
  const work = join(root, 'work')
  mkdirSync(join(work, 'src'), { recursive: true })
  writeFileSync(join(work, 'src', 'needle-here.txt'), 'x')
  const alpha = await runtimeOn(join(root, 'a.sock'), 'pi')
  const beta = await runtimeOn(join(root, 'b.sock'), 'claude-code')
  const device = new DeviceServer({
    stateDir: join(root, 'device'),
    upstreams: [
      { id: 'pi', connect: unixConnector(join(root, 'a.sock')) },
      { id: 'claude-code', connect: unixConnector(join(root, 'b.sock')) },
      // 没装的 harness：套接字不存在
      { id: 'dsh', connect: unixConnector(join(root, 'none.sock')) },
    ],
  })
  const listener = await listenUnix(join(root, 'device', 'device.sock'), (wire) =>
    device.attach(wire),
  )
  try {
    const client = await TestClient.overSocket(join(root, 'device', 'device.sock'))
    await client.initialize()
    const info = await client.call('runtime/info')
    assertRuntimeInfo(info)
    assert.deepEqual(
      info.harnesses.map((harness: any) => [
        harness.id,
        harness.version,
        harness.unavailable?.kind ?? 'ok',
      ]),
      [
        ['pi', '3.2.1', 'ok'],
        ['claude-code', '3.2.1', 'ok'],
        ['dsh', null, 'unreachable'],
      ],
    )
    // 给人看的那句不带设备上的路径（系统给的原文里有套接字的完整路径）
    assert.ok(!JSON.stringify(info.harnesses[2].unavailable).includes(root))
    assert.match(info.harnesses[2].unavailable.message, /套接字不在/)
    // 设备级的工作区由设备层处理；这两个上游没有项目这组方法，导入时当作没有，不碍事
    assert.deepEqual(await client.call('project/list', {}), { data: [], nextCursor: null })
    const list = await client.call('thread/list', {})
    assert.deepEqual(list.data.map((thread: any) => `${thread.id}@${thread.harness}`).sort(), [
      'claude-code-1@claude-code',
      'pi-1@pi',
    ])

    // 文件：写、读、列目录、监听
    const file = join(work, 'note.txt')
    await client.call('fs/watch', { watchId: 'w1', path: work })
    await client.call('fs/writeFile', { path: file, dataBase64: base64('设备层写的') })
    assert.equal(text((await client.call('fs/readFile', { path: file })).dataBase64), '设备层写的')
    const names = (await client.call('fs/readDirectory', { path: work })).entries.map(
      (entry: any) => entry.fileName,
    )
    assert.deepEqual(names.sort(), ['note.txt', 'src'])
    // macOS 上目录监听走文件系统事件：监听刚建好的那一小段系统还不送事件，赶上的话那次写就没有通知
    // （丢了，不是晚到；机器越忙这段越长）。没等到就再写一次，只要求监听起来之后的写有通知
    let changed: Awaited<ReturnType<typeof client.waitFor>> | null = null
    for (let attempt = 0; attempt < 15 && !changed; attempt++) {
      changed = await client
        .waitFor((frame) => frame.method === 'fs/changed', 1_000)
        .catch(() => null)
      if (!changed)
        await client.call('fs/writeFile', { path: file, dataBase64: base64('设备层写的') })
    }
    assert.ok(changed, '目录监听一直没有通知')
    assert.equal((changed.params as any).watchId, 'w1')
    assert.equal((await client.fails('fs/readFile', { path: 'relative' })).code, -32602)

    // 进程：不带终端的，输出流式回来
    await client.call('process/spawn', {
      processHandle: 'p1',
      command: ['/bin/sh', '-c', 'printf out; printf err >&2; exit 3'],
      cwd: work,
      streamStdoutStderr: true,
    })
    const exited = await client.waitFor(
      (frame) => frame.method === 'process/exited' && (frame.params as any).processHandle === 'p1',
    )
    assert.equal((exited.params as any).exitCode, 3)
    const output = (stream: string) =>
      client.notifications
        .filter((frame) => frame.method === 'process/outputDelta')
        .map((frame) => frame.params as any)
        .filter((params) => params.processHandle === 'p1' && params.stream === stream)
        .map((params) => text(params.deltaBase64))
        .join('')
    assert.deepEqual([output('stdout'), output('stderr')], ['out', 'err'])

    // 终端：带 tty 的，能写输入、能看到回显的输出
    await client.call('process/spawn', {
      processHandle: 'tty',
      command: ['/bin/sh'],
      cwd: work,
      tty: true,
      size: { rows: 10, cols: 40 },
      timeoutMs: null,
    })
    await client.call('process/writeStdin', {
      processHandle: 'tty',
      deltaBase64: base64('echo terminal-$((40+2)); exit\n'),
    })
    await client.waitFor(
      (frame) => frame.method === 'process/exited' && (frame.params as any).processHandle === 'tty',
      10_000,
    )
    const screen = client.notifications
      .filter((frame) => frame.method === 'process/outputDelta')
      .map((frame) => frame.params as any)
      .filter((params) => params.processHandle === 'tty')
      .map((params) => text(params.deltaBase64))
      .join('')
    assert.match(screen, /terminal-42/)

    // 模糊找文件
    const found = await client.call('fuzzyFileSearch', { query: 'needle', roots: [work] })
    assert.deepEqual(
      found.files.map((match: any) => match.path),
      ['src/needle-here.txt'],
    )

    // 这些请求一条都没有转给上游
    for (const calls of [alpha.calls, beta.calls])
      assert.deepEqual(
        calls.filter((method) => /^(fs|process|fuzzyFileSearch)/.test(method)),
        [],
      )
    assert.equal(
      (await client.fails('command/exec', { command: ['true'] })).data.litch,
      'unsupported',
    )

    // 客户端断开，它开的进程跟着结束
    await client.call('process/spawn', {
      processHandle: 'long',
      command: ['/bin/sh', '-c', 'sleep 60'],
      cwd: work,
      timeoutMs: null,
    })
    assert.equal(device.processes, 1)
    client.close()
    for (let waited = 0; waited < 3000 && device.processes > 0; waited += 50) await settle(50)
    assert.equal(device.processes, 0)
    assert.equal(device.connections, 0)
  } finally {
    await listener.close()
    await device.close()
    await alpha.transport.close()
    await beta.transport.close()
    rmSync(root, { recursive: true, force: true })
  }
})
