// 客户端工具的端到端自检（本机和远程各跑通一次 litch_echo）。不起界面、不起 Electron：
// 真的核心加主进程那一份执行器登记表（dist/tools-check.mjs，源码在 src/client-tools/check.mts），
//   1. 本机：对着 scripts/client-fixture.mjs 起的隔离 Pi 入口（模型是回环上的假模型）；
//   2. 远程：对着 scripts/client-ssh-fixture.mjs 起的假远程机器（回环上的 sshd，里面的“codex”背后接的也是一份隔离的 Pi），
//      经系统的 ssh 连过去，引擎发来的工具调用顺着 ssh 回到这一头执行。
// 要先构建 packages/pi（远程那份夹具还要 npm run build 编出来的命令行）。
//   npm run check:client-tools            两段都跑
//   npm run check:client-tools -- --local  只跑本机；--remote 只跑远程
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const tool = fileURLToPath(new URL('../dist/tools-check.mjs', import.meta.url))
const only = process.argv.includes('--local')
  ? 'local'
  : process.argv.includes('--remote')
    ? 'remote'
    : null

function startFixture(script, marker) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = new Promise((done) => child.on('exit', done))
    let output = ''
    let ready = false
    const onData = (chunk) => {
      output += chunk
      if (ready) return
      const line = output.split('\n').find((entry) => entry.startsWith(`${marker} `))
      if (!line) return
      ready = true
      resolve({
        info: JSON.parse(line.slice(marker.length + 1)),
        log: () => output,
        stop() {
          child.kill('SIGTERM')
          return Promise.race([exited, new Promise((done) => setTimeout(done, 30_000))])
        },
      })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) => {
      if (!ready) reject(new Error(`夹具没起来（退出码 ${code}）：\n${output}`))
    })
  })
}

/** 跑一遍自检小工具，它的每一行原样打出来；返回它退出时是不是都对了 */
function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tool, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    // 自己有时限：小工具里的每一步也各有时限，这里兜底
    const timer = setTimeout(() => child.kill('SIGKILL'), 240_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

const results = []
if (only !== 'remote') {
  console.log('—— 本机：隔离的 Pi 入口 ——')
  const fixture = await startFixture('scripts/client-fixture.mjs', 'LITCH_FIXTURE')
  try {
    results.push(['local', await run(['--entry', fixture.info.entry], {})])
  } finally {
    await fixture.stop()
  }
}
if (only !== 'local') {
  console.log('—— 远程：假的远程机器，经 ssh ——')
  const fixture = await startFixture('scripts/client-ssh-fixture.mjs', 'LITCH_SSH_FIXTURE')
  try {
    results.push([
      'remote',
      await run(['--ssh', fixture.info.aliases.ok], {
        LITCH_SSH_CONFIG: fixture.info.config,
        LITCH_REMOTE_CODEX: fixture.info.codex,
        LITCH_REMOTE_ADAPTER: fixture.info.adapter,
      }),
    ])
  } finally {
    await fixture.stop()
  }
}
const ok = results.every(([, passed]) => passed)
console.log(
  `客户端工具自检：${results.map(([name, passed]) => `${name} ${passed ? '过' : '没过'}`).join('，')}`,
)
process.exit(ok ? 0 : 1)
