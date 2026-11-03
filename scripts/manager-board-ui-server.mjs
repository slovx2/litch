// 真实设备夹具与浏览器共用一个开发源；沿用正式 CSP，不放开跨源脚本或连接。
import { spawn } from 'node:child_process'
import { unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'

export async function managerBoardUiServer(repo, rpcPort, corePort) {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const config = join(repo, '.artifacts', `manager-refresh-vite-${process.pid}.mjs`)
  writeFileSync(
    config,
    `import base from ${JSON.stringify(join(repo, 'packages/ui/vite.config.ts'))};
    export default {...base, root:${JSON.stringify(join(repo, 'packages/ui'))},
      server:{...base.server,port:${port},proxy:{
        '/fixture-rpc':{target:'ws://127.0.0.1:${rpcPort}',ws:true,rewrite:()=> '/'},
        '/fixture-core.mjs':{target:'http://127.0.0.1:${corePort}'},
      }}};`,
  )
  const server = spawn(
    process.execPath,
    [join(repo, 'packages/ui/node_modules/vite/bin/vite.js'), '--config', config],
    {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  server.stdout.on('data', (chunk) => {
    output += chunk
  })
  server.stderr.on('data', (chunk) => {
    output += chunk
  })
  const close = async () => {
    server.kill()
    if (server.exitCode === null) await new Promise((resolve) => server.once('exit', resolve))
    unlinkSync(config)
  }
  try {
    const url = `http://127.0.0.1:${port}`
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(url)).ok) return { url, port, close }
      } catch {}
      if (server.exitCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`隔离 Vite 未就绪：${output}`)
  } catch (error) {
    await close()
    throw error
  }
}
