// 套接字文件的路径里有空格、有中文时也要连得上。
// 用户的主目录就可能是这样（macOS 上带空格的全名、中文的用户名），状态目录默认在主目录下面。
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { listenUnix, unixConnector } from '../src/sockets.mjs'
import { tempDir } from './helpers.mjs'

test('套接字的路径里有空格和中文：监听得起来，连得上，帧对得上', async () => {
  const root = tempDir()
  const directory = join(root, '张 三')
  mkdirSync(directory)
  const path = join(directory, 'runtime.sock')
  const received: string[] = []
  const listener = await listenUnix(path, (wire) => ({
    message(text) {
      received.push(text)
      wire.send(`收到：${text}`)
    },
    close() {},
  }))
  try {
    let answered: (text: string) => void = () => {}
    const answer = new Promise<string>((resolve) => {
      answered = resolve
    })
    // 连不上的话在这里就抛出来，不会干等那一句回话
    const wire = await unixConnector(path)({ message: answered, close() {} })
    wire.send('你好')
    assert.equal(await answer, '收到：你好')
    wire.close()
    assert.deepEqual(received, ['你好'])
  } finally {
    await listener.close()
    rmSync(root, { recursive: true, force: true })
  }
})
