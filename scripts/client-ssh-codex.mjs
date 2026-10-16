// 自检用的“远程机器上的 codex”替身。只学了客户端连远程设备时用到的那三样，表现照着原生 codex：
//   --version                      打印版本号
//   app-server --listen unix://    常驻：在控制套接字上监听，每条连接原样接到隔离入口的套接字上；
//                                  已经有一份在听就报错退出，原来那份不受影响
//   app-server proxy               把标准输入输出接到控制套接字上；连不上以 1 退出
// 由 client-ssh-fixture.mjs 生成的包装脚本调用，要用的路径都从环境变量里来。
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'

const { LITCH_FX_SOCK: sock, LITCH_FX_ENTRY: entry, LITCH_FX_MODE: mode } = process.env
const args = process.argv.slice(2)
const fail = (message) => {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
}
if (!sock || !entry) fail('替身没有拿到套接字的路径')

if (args[0] === '--version') {
  // old：一个低于下限的版本，用来验“版本太低”那条路
  console.log(mode === 'old' ? 'codex-cli 0.98.0' : 'codex-cli 0.162.0')
} else if (args[0] === 'app-server' && args[1] === 'proxy') {
  const link = connect(sock)
  link.once('error', (error) => fail(`failed to connect to socket at ${sock}: ${error.message}`))
  link.once('connect', () => {
    process.stdin.pipe(link)
    link.pipe(process.stdout)
    // 哪一头先结束，另一头跟着结束
    link.once('close', () => process.exit(0))
    process.stdin.once('end', () => link.end())
  })
} else if (args[0] === 'app-server' && args.includes('--listen')) {
  // nostart：一起来就退，用来验“服务起不来”那条路
  if (mode === 'nostart') fail('替身按要求启动失败')
  const probe = connect(sock)
  probe.once('connect', () => fail(`app-server control socket is already in use at ${sock}`))
  probe.once('error', () => {
    // 没人在听：留下的旧文件清掉，自己来听
    if (existsSync(sock)) rmSync(sock, { force: true })
    const server = createServer((client) => {
      const upstream = connect(entry)
      client.pipe(upstream)
      upstream.pipe(client)
      const close = () => {
        client.destroy()
        upstream.destroy()
      }
      client.once('error', close)
      upstream.once('error', close)
      client.once('close', close)
      upstream.once('close', close)
    })
    server.listen(sock, () => {
      // 记下进程号：隔离环境收尾时按它结束这一份
      writeFileSync(`${sock}.pid`, String(process.pid))
    })
    server.once('error', (error) => fail(error.message))
  })
} else {
  fail(`替身不认识这个用法：${args.join(' ')}`)
}
