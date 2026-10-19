// 扫码绑定手机在外壳这一头的自检：起一台假的远程机器（scripts/client-ssh-fixture.mjs，用户态的 sshd），
// 拿 dist/pair-check.mjs 把私钥文件、地址解析、known_hosts 核对、本机的 SSH 横幅、一次性钥匙自检和整条链过一遍。
// 不起界面，不碰这台电脑真的 ~/.ssh：known_hosts、钥匙文件、ssh 配置都是夹具临时目录里的。
// 整条链要设备服务列了 devicePairing；还没有时那一段跳过并写明，别的照样要过。
//   npm run check:pair
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('../../..', import.meta.url))
const tool = fileURLToPath(new URL('../dist/pair-check.mjs', import.meta.url))

/** 起假的远程机器，等它就绪 */
function startFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/client-ssh-fixture.mjs'], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const onData = (chunk) => {
      output += chunk
      const line = output.split('\n').find((entry) => entry.startsWith('LITCH_SSH_FIXTURE '))
      if (!line) return
      resolve({
        ...JSON.parse(line.slice('LITCH_SSH_FIXTURE '.length)),
        stop: () =>
          new Promise((done) => {
            child.once('exit', done)
            child.kill('SIGTERM')
          }),
      })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('exit', (code) =>
      reject(new Error(`假的远程机器没起来（退出码 ${code}）：\n${output}`)),
    )
  })
}

const fixture = await startFixture()
let code = 1
try {
  code = await new Promise((done, fail) => {
    const child = spawn(
      process.execPath,
      [tool, JSON.stringify({ root: fixture.root, aliases: fixture.aliases })],
      {
        env: {
          ...process.env,
          LITCH_SSH_CONFIG: fixture.config,
          LITCH_REMOTE_CODEX: fixture.codex,
          LITCH_REMOTE_ADAPTER: fixture.adapter,
        },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    let rest = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      rest += chunk
      const lines = rest.split('\n')
      rest = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('LITCH_PAIR_CHECK ')) continue
        const { name, ok, ...detail } = JSON.parse(line.slice('LITCH_PAIR_CHECK '.length))
        const shown = ok ? '' : ` ${JSON.stringify(detail)}`
        console.log(
          `${ok ? '✓' : '✗'} ${name}${name === 'chainSkipped' ? `（${detail.reason}）` : ''}${shown}`,
        )
      }
    })
    child.on('error', fail)
    child.on('exit', (exit) => done(exit ?? 1))
  })
} finally {
  await fixture.stop()
}
console.log(code === 0 ? '扫码绑定的外壳自检：全部通过' : '扫码绑定的外壳自检：有没过的')
process.exit(code)
