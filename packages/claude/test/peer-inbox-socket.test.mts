import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { claimPeerInboxSocket, peerInboxSocketPaths } from '../src/peer-inbox-socket.mjs'

// 套接字路径有长度上限，临时目录放在 /tmp 下（macOS 的 tmpdir() 太长）
const shortTemp = (): Promise<string> => mkdtemp('/tmp/lps-')

test('固定地址按会话键起名：照 CLI 的默认目录，太长时退到 /tmp/cc-socks-<uid>，键不像文件名时不给', () => {
  const key = '0ee16b91-c9c1-469a-95bd-74f766904972'
  assert.deepEqual(peerInboxSocketPaths(key, { XDG_RUNTIME_DIR: '/run/user/0' }, 0), [
    `/run/user/0/cc-socks/litch-${key}.sock`,
    `/tmp/cc-socks-0/litch-${key}.sock`,
  ])
  assert.deepEqual(peerInboxSocketPaths(key, {}, 501), [
    `/tmp/cc-socks/litch-${key}.sock`,
    `/tmp/cc-socks-501/litch-${key}.sock`,
  ])
  assert.deepEqual(peerInboxSocketPaths(key, { CLAUDE_CODE_TMPDIR: `/${'x'.repeat(80)}` }, 501), [
    `/tmp/cc-socks-501/litch-${key}.sock`,
  ])
  assert.deepEqual(peerInboxSocketPaths('../escape', {}, 501), [])
})

test('挑地址：目录不在就建成私有的；上个进程强杀留下的文件不算占用；有进程在听时让 CLI 自己起', async () => {
  const base = await shortTemp()
  const servers: Server[] = []
  try {
    const env = { XDG_RUNTIME_DIR: base }
    const path = await claimPeerInboxSocket('thread-a', env)
    assert.equal(path, join(base, 'cc-socks', 'litch-thread-a.sock'))
    assert.equal(statSync(join(base, 'cc-socks')).mode & 0o777, 0o700)

    // 强杀留下的：文件在、没人听
    const holder = spawn(process.execPath, [
      '-e',
      "require('node:net').createServer().listen(process.argv[1], () => console.log('up'))",
      path as string,
    ])
    await new Promise((resolve) => holder.stdout.once('data', resolve))
    holder.kill('SIGKILL')
    await new Promise((resolve) => holder.once('exit', resolve))
    assert.ok(statSync(path as string).isSocket(), '套接字文件还留着')
    assert.equal(await claimPeerInboxSocket('thread-a', env), path)

    const live = createServer()
    servers.push(live)
    await new Promise<void>((resolve) =>
      live.listen(join(base, 'cc-socks', 'litch-b.sock'), resolve),
    )
    assert.equal(await claimPeerInboxSocket('b', env), null)
  } finally {
    for (const server of servers) server.close()
    await rm(base, { recursive: true, force: true })
  }
})

test('默认目录不是私有的（CLI 会拒绝）时不用它', async () => {
  const base = await shortTemp()
  try {
    mkdirSync(join(base, 'cc-socks'), { mode: 0o755 })
    chmodSync(join(base, 'cc-socks'), 0o755)
    const path = await claimPeerInboxSocket('thread-c', { XDG_RUNTIME_DIR: base })
    assert.notEqual(path, join(base, 'cc-socks', 'litch-thread-c.sock'))
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
