// 属于设备的进程不随连接结束，但设备进程自己退出时要把它们连同子进程一起带走，不留孤儿。
// 起的是真的设备进程（构建出来的入口），做法照 orphan.test.mts。
import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { REPO, settle, tempDir } from './helpers.mjs'
import { list, OPEN, output, SocketClient, until } from './process-kit.mjs'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 一个扮演常驻的 Go 层的进程拉起设备进程，返回两边的进程号 */
async function launch(root: string): Promise<{ parent: ChildProcess; device: number }> {
  const main = join(REPO, 'packages/device/dist/device/src/main.mjs')
  const socket = join(root, 'device', 'device.sock')
  const args = [main, '--listen', `unix://${socket}`, '--state', join(root, 'device')]
  const script = `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ${JSON.stringify(args)}, {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    child.stdout.on('data', (data) => {
      output += data
      if (output.split('\\n').includes('LITCH_DEVICE_READY')) console.log('DEVICE ' + child.pid)
    })
    setInterval(() => {}, 1000)
  `
  const parent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  const device = await new Promise<number>((resolve, reject) => {
    let seen = ''
    const timer = setTimeout(() => reject(new Error('设备进程 30 秒没有就绪')), 30_000)
    parent.stdout?.on('data', (data) => {
      seen += data
      const found = seen.match(/DEVICE (\d+)\n/)
      if (!found) return
      clearTimeout(timer)
      resolve(Number(found[1]))
    })
  })
  return { parent, device }
}

/** quit：让设备进程退出的办法 */
async function leavesNoOrphans(quit: (parent: ChildProcess, device: number) => void) {
  const root = tempDir()
  const socket = join(root, 'device', 'device.sock')
  const pids: number[] = []
  let parent: ChildProcess | null = null
  let device = 0
  try {
    ;({ parent, device } = await launch(root))
    const client = await SocketClient.connect(socket)
    // 一个带伪终端、一个不带；各自再起一个子进程，把两个进程号都报出来
    for (const [handle, tty] of [
      ['pty', true],
      ['pipe', false],
    ] as const) {
      await client.call('process/spawn', {
        processHandle: handle,
        command: ['/bin/sh', '-c', 'sleep 300 & echo "PIDS $$ $!"; wait'],
        cwd: root,
        ...(tty ? { tty: true } : {}),
        ...OPEN,
        litchDevice: {},
      })
      await until(`${handle} 报出了进程号`, () => /PIDS \d+ \d+/.test(output(client, handle)))
      const found = output(client, handle).match(/PIDS (\d+) (\d+)/) as RegExpMatchArray
      pids.push(Number(found[1]), Number(found[2]))
    }
    assert.equal((await list(client)).length, 2)
    // 连接断了，这些进程不该跟着结束
    await client.close()
    await settle(500)
    assert.deepEqual(pids.map(alive), [true, true, true, true], '连接断开之后进程都还在')

    quit(parent, device)
    await until(
      '设备进程和它名下的进程、它们的子进程全都结束了',
      () => !alive(device) && pids.every((pid) => !alive(pid)),
      20_000,
    )
    assert.equal(existsSync(socket), false, '套接字清掉了')
  } finally {
    parent?.kill('SIGKILL')
    for (const pid of [device, ...pids])
      if (pid && alive(pid))
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // 刚好在这一刻自己没了
        }
    rmSync(root, { recursive: true, force: true })
  }
}

test('拉起它的进程被强杀：设备进程自己退出时，属于设备的进程连同子进程一起结束', async () => {
  await leavesNoOrphans((parent) => parent.kill('SIGKILL'))
})

test('设备进程被要求退出（SIGTERM）：属于设备的进程连同子进程一起结束', async () => {
  await leavesNoOrphans((_parent, device) => process.kill(device, 'SIGTERM'))
})
