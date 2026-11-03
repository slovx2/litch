// 传输分段：同一份看板 JSON，经回环 WebSocket 直连和临时 sshd 端口转发。
// 不启动远端 shell，不使用用户的配置、密钥、agent 或 known_hosts。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { WebSocket, WebSocketServer } from 'ws'

const forwardOnly = process.argv[2] === '--forward'
const payload = forwardOnly
  ? ''
  : JSON.stringify({ board: JSON.parse(readFileSync(process.argv[2], 'utf8')).board })
const root = mkdtempSync(join(tmpdir(), 'manager-board-ssh-'))
const children = []
const freePort = async () => {
  const server = createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  await new Promise((r) => server.close(r))
  return port
}
const ready = async (port) => {
  for (let i = 0; i < 100; i++) {
    const success = await new Promise((r) => {
      const socket = connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        r(true)
      })
      socket.once('error', () => r(false))
    })
    if (success) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`端口 ${port} 未就绪`)
}
const server = forwardOnly ? null : new WebSocketServer({ host: '127.0.0.1', port: 0 })
if (server) {
  await new Promise((r) => server.once('listening', r))
  server.on('connection', (socket) => socket.on('message', () => socket.send(payload)))
}
const port = server ? server.address().port : Number(process.argv[3])
const results = { bytes: Buffer.byteLength(payload) }
const measure = async (name, target) => {
  const start = performance.now()
  const ws = new WebSocket(`ws://127.0.0.1:${target}`)
  await new Promise((r, reject) => {
    ws.once('open', r)
    ws.once('error', reject)
  })
  const connectMs = performance.now() - start
  const samplesMs = []
  for (let i = 0; i < 7; i++) {
    const start = performance.now()
    const received = new Promise((r) => ws.once('message', r))
    ws.send('{}')
    const data = await received
    assert.equal(data.length, Buffer.byteLength(payload))
    samplesMs.push(performance.now() - start)
  }
  ws.close()
  await new Promise((r) => ws.once('close', r))
  results[name] = { connectMs, medianMs: [...samplesMs].sort((a, b) => a - b)[3], samplesMs }
}
try {
  if (!forwardOnly) await measure('local', port)
  const sshPort = await freePort()
  const forwarded = await freePort()
  for (const name of ['host', 'client'])
    execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)])
  writeFileSync(join(root, 'authorized_keys'), readFileSync(join(root, 'client.pub')))
  writeFileSync(
    join(root, 'known_hosts'),
    `[127.0.0.1]:${sshPort} ${readFileSync(join(root, 'host.pub'), 'utf8')}`,
  )
  writeFileSync(
    join(root, 'sshd_config'),
    [
      `Port ${sshPort}`,
      'ListenAddress 127.0.0.1',
      `HostKey ${root}/host`,
      `PidFile ${root}/sshd.pid`,
      `AuthorizedKeysFile ${root}/authorized_keys`,
      'PubkeyAuthentication yes',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'UsePAM no',
      'StrictModes no',
      'AllowTcpForwarding local',
      'AllowAgentForwarding no',
      'X11Forwarding no',
      'PermitTunnel no',
      `SetEnv HOME=${root}`,
      '',
    ].join('\n'),
  )
  const isolated = { HOME: root, PATH: '/usr/bin:/bin', TMPDIR: root }
  const daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(root, 'sshd_config')], {
    env: isolated,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  children.push(daemon)
  let diagnostics = ''
  daemon.stderr.on('data', (chunk) => {
    diagnostics += chunk
  })
  await ready(sshPort)
  const start = performance.now()
  const ssh = spawn(
    '/usr/bin/ssh',
    [
      '-F',
      '/dev/null',
      '-N',
      '-T',
      '-p',
      String(sshPort),
      '-i',
      join(root, 'client'),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      `UserKnownHostsFile=${root}/known_hosts`,
      '-o',
      'GlobalKnownHostsFile=/dev/null',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-L',
      `127.0.0.1:${forwarded}:127.0.0.1:${port}`,
      `${userInfo().username}@127.0.0.1`,
    ],
    { env: isolated, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  children.push(ssh)
  ssh.stderr.on('data', (chunk) => {
    diagnostics += chunk
  })
  try {
    await ready(forwarded)
  } catch (error) {
    throw new Error(`${error}: ${diagnostics}`)
  }
  results.sshConnectMs = performance.now() - start
  if (forwardOnly) {
    console.log(JSON.stringify({ port: forwarded }))
    await new Promise((resolve) => {
      process.once('SIGTERM', resolve)
      process.once('SIGINT', resolve)
    })
  } else {
    await measure('ssh', forwarded)
    console.log(JSON.stringify(results, null, 2))
  }
} finally {
  for (const child of children.reverse()) {
    child.kill()
    if (child.exitCode === null) await new Promise((r) => child.once('exit', r))
  }
  if (server) await new Promise((r) => server.close(r))
  rmSync(root, { recursive: true, force: true })
}
