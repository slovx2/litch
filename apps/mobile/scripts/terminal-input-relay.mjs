// 只在断线验收中转发隔离 sshd；不改真实 SSH 配置。手机取到的是转发端口。
import { createServer as httpServer } from 'node:http'
import { connect, createServer } from 'node:net'

export async function terminalInputRelay(config) {
  if (!/^\/tmp\/litch-ssh-[^/]+$/.test(config.root) || config.target.host !== '127.0.0.1') {
    throw new Error('终端断线验收必须使用回环隔离 SSH 夹具')
  }
  let enabled = true
  const connections = new Set()
  const server = createServer((near) => {
    if (!enabled) return near.destroy()
    const far = connect(config.target.port, '127.0.0.1')
    const pair = { near, far }
    connections.add(pair)
    const close = () => {
      connections.delete(pair)
      near.destroy()
      far.destroy()
    }
    near.on('error', close).on('close', close)
    far.on('error', close).on('close', close)
    near.pipe(far).pipe(near)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const proxied = { ...config, target: { ...config.target, port: server.address().port } }
  const http = httpServer((request, response) => {
    if (request.url !== '/config') return response.writeHead(404).end()
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(proxied))
  })
  try {
    await new Promise((resolve, reject) => {
      http.once('error', reject)
      http.listen(8765, '127.0.0.1', resolve)
    })
  } catch (error) {
    server.close()
    throw error
  }
  const down = () => {
    enabled = false
    for (const { near, far } of connections) {
      near.destroy()
      far.destroy()
    }
  }
  return {
    down,
    up() {
      enabled = true
    },
    async stop() {
      down()
      await Promise.all([server, http].map((one) => new Promise((resolve) => one.close(resolve))))
    },
  }
}
