// 流量控制：按连接看发送的积压，过了线就不读进程的输出。
// 要一条真的会堵的连接，所以经真的套接字连：客户端停下不读，系统的缓冲满了之后积压就在设备这边。
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { type DeviceOptions, DeviceServer } from '../src/device.mjs'
import { listenUnix } from '../src/sockets.mjs'
import { settle, tempDir } from './helpers.mjs'
import {
  collect,
  exited,
  FEED,
  lines,
  list,
  OPEN,
  plainOutput,
  SocketClient,
  until,
  write,
} from './process-kit.mjs'

/** 线压得很低，几兆字节的输出就足够把连接堵上 */
const TIGHT = { highBytes: 64 * 1024, lowBytes: 16 * 1024 }
const COUNT = 600_000
const EXPECTED = Buffer.from(lines(1, COUNT))

async function served(more: Partial<DeviceOptions> = {}) {
  const root = tempDir()
  const path = join(root, 'device', 'device.sock')
  const device = new DeviceServer({
    stateDir: join(root, 'device'),
    upstreams: [],
    importExisting: false,
    flow: TIGHT,
    ...more,
  })
  const listener = await listenUnix(path, (wire) => device.attach(wire))
  return {
    root,
    path,
    device,
    async close() {
      await listener.close()
      await device.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

test('唯一挂着的连接不读：进程被按住，设备读进来的不再涨；恢复之后接着出，一个字节不丢', async () => {
  const setup = await served({ processes: { bufferBytes: 128 * 1024 } })
  const slow = await SocketClient.connect(setup.path)
  // 另一条连接不挂接，只用来看这个进程到现在出了多少
  const watcher = await SocketClient.connect(setup.path)
  try {
    await slow.call('process/spawn', {
      processHandle: 'flood',
      command: FEED,
      cwd: setup.root,
      streamStdin: true,
      ...OPEN,
      litchDevice: {},
    })
    slow.pause()
    // 停下不读之后才让它出。请求照样发得出去，应答要等恢复了才读得到，先不等
    const asked = write(slow, 'flood', `1 ${COUNT} 0\n`)
    let seen = -1
    let steady = 0
    await until(
      '设备不再读这个进程的输出',
      async () => {
        const [item] = await list(watcher)
        steady = item.retained.to > 0 && item.retained.to === seen ? steady + 1 : 0
        seen = item.retained.to
        await settle(100)
        return steady >= 4
      },
      20_000,
    )
    // 几兆字节的输出只读进来一小部分：进程停在写上了，没有在设备这边越堆越多
    assert.ok(seen < EXPECTED.length / 4, `读进来 ${seen} 字节，一共 ${EXPECTED.length}`)
    assert.equal(collect(slow.notifications, 'flood').end, 0, '这条连接一帧都还没读')
    slow.resume()
    await asked
    await until(
      '恢复之后全部收到',
      () => collect(slow.notifications, 'flood').end === EXPECTED.length,
      30_000,
    )
    const got = collect(slow.notifications, 'flood')
    assert.deepEqual([got.start, got.contiguous, got.missed], [0, true, 0])
    assert.ok(got.data.equals(EXPECTED), '内容和不堵的时候一模一样')
    // 进程没有因为被按住过而坏掉：接着用
    await write(slow, 'flood', '1 3 0\n')
    await until('还能接着出', () =>
      collect(slow.notifications, 'flood')
        .data.subarray(EXPECTED.length)
        .equals(Buffer.from(lines(1, 3))),
    )
  } finally {
    await slow.close()
    await watcher.close()
    await setup.close()
  }
})

test('两条连接挂着同一个进程，一条不读：拖不住另一条；它自己落后的那一段丢掉，并且知道丢了多少', async () => {
  const setup = await served({ processes: { bufferBytes: 128 * 1024 } })
  const fast = await SocketClient.connect(setup.path)
  const slow = await SocketClient.connect(setup.path)
  try {
    await fast.call('process/spawn', {
      processHandle: 'pair',
      command: FEED,
      cwd: setup.root,
      streamStdin: true,
      ...OPEN,
      litchDevice: {},
    })
    await slow.call('litch/process/attach', { processHandle: 'pair' })
    slow.pause()
    await write(fast, 'pair', `1 ${COUNT} 0\n`)
    await until(
      '跟得上的那条全收到了',
      () => collect(fast.notifications, 'pair').end === EXPECTED.length,
      30_000,
    )
    const quick = collect(fast.notifications, 'pair')
    assert.deepEqual([quick.start, quick.contiguous, quick.missed], [0, true, 0])
    assert.ok(quick.data.equals(EXPECTED))
    // 这时不读的那条连一帧都没读；放开之后它拿到的是开头堵住之前的那点和缓冲里的末尾
    assert.equal(collect(slow.notifications, 'pair').frames, 0)
    slow.resume()
    await until(
      '落后的那条追到了末尾',
      () => collect(slow.notifications, 'pair').end === EXPECTED.length,
      30_000,
    )
    const late = collect(slow.notifications, 'pair')
    assert.deepEqual([late.start, late.contiguous], [0, true])
    assert.ok(late.missed > 0, '中间少了一段，帧上说了少了多少')
    assert.equal(late.data.length + late.missed, EXPECTED.length, '收到的加上说丢了的，正好是全部')
    const tail = 64 * 1024
    assert.ok(late.data.subarray(-tail).equals(EXPECTED.subarray(-tail)), '末尾那一段是全的')
  } finally {
    await fast.close()
    await slow.close()
    await setup.close()
  }
})

test('属于连接的进程也一样：连接不读就按住它，通知的内容不变', async () => {
  const setup = await served()
  // 没声明这项扩展的连接：标准的 process/spawn
  const client = await SocketClient.connect(setup.path, ['harness'])
  const marker = join(setup.root, 'finished')
  try {
    client.pause()
    const asked = client.call('process/spawn', {
      processHandle: 'own',
      command: ['/bin/sh', '-c', 'seq 1 "$1"; echo END; echo yes > "$2"', 'sh', `${COUNT}`, marker],
      cwd: setup.root,
      streamStdoutStderr: true,
      ...OPEN,
    })
    // 不按住的话这点输出零点几秒就读完了，进程早就跑到最后一步
    await settle(1500)
    assert.equal(existsSync(marker), false, '进程停在写上，没有跑完')
    client.resume()
    assert.deepEqual(await asked, {})
    await exited(client, 'own', 30_000)
    assert.equal(existsSync(marker), true)
    assert.ok(Buffer.from(plainOutput(client, 'own')).equals(EXPECTED), '一个字节不丢')
  } finally {
    await client.close()
    await setup.close()
  }
})

/** 等到设备不再读这个进程的输出（连着几次看，出的总量都没变），返回停在多少 */
async function stalled(watcher: SocketClient, handle: string): Promise<number> {
  let seen = -1
  let steady = 0
  await until(
    `设备不再读 ${handle} 的输出`,
    async () => {
      const item = (await list(watcher)).find((entry) => entry.processHandle === handle)
      // 还在起的进程列表里没有
      const to = item?.retained.to ?? 0
      steady = to > 0 && to === seen ? steady + 1 : 0
      seen = to
      await settle(100)
      return steady >= 4
    },
    20_000,
  )
  return seen
}

test('伪终端也一样：连接不读时终端里的程序停下，恢复之后一个字节不丢；按住的时候照样结束得了', async () => {
  const setup = await served({ processes: { bufferBytes: 128 * 1024 } })
  const slow = await SocketClient.connect(setup.path)
  const watcher = await SocketClient.connect(setup.path)
  // 终端把换行变成回车换行
  const expected = Buffer.from(lines(1, COUNT).replaceAll('\n', '\r\n'))
  const terminal = { cwd: setup.root, tty: true, ...OPEN, litchDevice: {} }
  try {
    slow.pause()
    // 出完之后不退出：留着这个终端，后面拿它试结束
    const asked = slow.call('process/spawn', {
      ...terminal,
      processHandle: 'pty',
      command: ['/bin/sh', '-c', 'seq 1 "$1"; echo END; sleep 60', 'sh', `${COUNT}`],
    })
    const seen = await stalled(watcher, 'pty')
    assert.ok(seen < expected.length / 4, `读进来 ${seen} 字节，一共 ${expected.length}`)
    slow.resume()
    await asked
    // 伪终端的输出队列满的时候，macOS 偶尔会把换行前的回车多写一个（系统自己的行为，不经我们、
    // 直接慢慢读伪终端也一样）。所以总量可能比算出来的多几个字节：等到最后一行到了为止，
    // 比内容之前把多出来的回车去掉
    const last = Buffer.from('END\r\n')
    await until(
      '恢复之后全部收到',
      () => {
        const now = collect(slow.notifications, 'pty')
        return now.end >= expected.length && now.data.subarray(-last.length).equals(last)
      },
      30_000,
    )
    const got = collect(slow.notifications, 'pty')
    assert.deepEqual([got.start, got.contiguous, got.missed], [0, true, 0])
    const [item] = await list(watcher)
    assert.equal(got.end, item.retained.to, '设备读进来多少，这条连接就收到多少')
    const text = got.data.toString('latin1').replace(/\r+\n/g, '\r\n')
    assert.ok(Buffer.from(text, 'latin1').equals(expected), '内容和不堵的时候一模一样')

    // 一个不停往外刷的程序，把连接堵上；按住的时候别的连接来结束它
    await slow.call('process/spawn', {
      ...terminal,
      processHandle: 'spin',
      command: ['/usr/bin/yes', 'spinning'],
    })
    slow.pause()
    await stalled(watcher, 'spin')
    await watcher.call('litch/process/kill', { processHandle: 'spin' })
    await until(
      '按住的进程结束了',
      async () =>
        (await list(watcher)).find((entry) => entry.processHandle === 'spin').running === false,
    )
    slow.resume()
    const gone = await exited(slow, 'spin', 30_000)
    const spun = collect(slow.notifications, 'spin')
    assert.deepEqual([spun.contiguous, spun.missed, gone.litchDevice.offset], [true, 0, spun.end])
    assert.match(spun.data.subarray(0, 24).toString(), /^spinning\r+\nspinning/)
  } finally {
    await slow.close()
    await watcher.close()
    await setup.close()
  }
})
