import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { REPO, settle, TestClient, tempDir } from './helpers.mjs'

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('拉起它的进程被强杀：设备进程自己退出，并把聚合面的套接字清掉', async () => {
  const root = tempDir()
  const socket = join(root, 'device', 'device.sock')
  const main = join(REPO, 'packages/device/dist/device/src/main.mjs')
  // 中间这个进程扮演常驻的 Go 层：照定死的命令行拉起设备进程（自成一组，标准输出接管道），
  // 见到就绪标记后把设备进程的进程号报出来，然后一直等着
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
  let device = 0
  try {
    device = await new Promise<number>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error('设备进程 30 秒没有就绪')), 30_000)
      parent.stdout.on('data', (data) => {
        output += data
        const found = output.match(/DEVICE (\d+)\n/)
        if (!found) return
        clearTimeout(timer)
        resolve(Number(found[1]))
      })
    })
    // 就绪标记出来的时候聚合面已经能连、能握手
    const client = await TestClient.overSocket(socket)
    await client.initialize()
    client.close()

    parent.kill('SIGKILL')
    for (let waited = 0; waited < 10_000 && alive(device); waited += 100) await settle(100)
    assert.equal(alive(device), false, '设备进程退出了')
    assert.equal(existsSync(socket), false, '套接字清掉了')
  } finally {
    parent.kill('SIGKILL')
    if (device && alive(device)) process.kill(device, 'SIGKILL')
    rmSync(root, { recursive: true, force: true })
  }
})
