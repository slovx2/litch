// 给现有 tyrs-hand 移动端（对照组）用的远端替身：它经 SSH 只认 `tyrs-hand-worker runtime info` 和 `codex app-server proxy`。
// 这里把它接到和原型同一个设备服务里的 Pi 运行时上（标准 Codex 协议的单 harness 入口），
// 两边连的是同一个 Pi、同一个假模型，长回答一字不差。由 fixture.mjs 生成的包装脚本调用：
//   tyrs-hand-worker runtime info   报一份身份（引擎 pi，协议版本按它要求的写）
//   codex --version                 报它要求的版本
//   codex app-server daemon start   什么都不做：Pi 运行时由设备服务管着
//   codex app-server proxy          把标准输入输出接到 Pi 运行时的套接字上
import { connect } from 'node:net'

const { LEGACY_TOOL: tool, LEGACY_SOCK: sock } = process.env
const args = process.argv.slice(2)
const fail = (message) => {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
}

if (tool === 'worker') {
  if (args[0] === 'runtime' && args[1] === 'info') {
    console.log(
      JSON.stringify({
        workerId: 'litch-mobile-fixture',
        engine: 'pi',
        protocolVersion: '0.157.1',
        status: 'running',
        capabilities: [],
        releaseReady: true,
      }),
    )
  } else fail(`替身不认识这个用法：${args.join(' ')}`)
} else if (args[0] === '--version') {
  console.log('codex-cli 0.157.1')
} else if (args[0] === 'app-server' && args[1] === 'daemon') {
  process.exit(0)
} else if (args[0] === 'app-server' && args[1] === 'proxy') {
  if (!sock) fail('替身没有拿到套接字的路径')
  const link = connect(sock)
  link.once('error', (error) => fail(`failed to connect to socket at ${sock}: ${error.message}`))
  link.once('connect', () => {
    process.stdin.pipe(link)
    link.pipe(process.stdout)
    link.once('close', () => process.exit(0))
    process.stdin.once('end', () => link.end())
  })
} else {
  fail(`替身不认识这个用法：${args.join(' ')}`)
}
