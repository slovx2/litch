// 给移动端原型用的“假的远程机器”：起仓库自带的 ssh 夹具（scripts/client-ssh-fixture.mjs），
// 取出装了适配器的那个情形（svc）怎么连，写成手机端 SSH 模块认的连接配置（mobile/sshtransport 的 Target）。
// 背后是真的适配器设备服务、隔离的 Pi 和回环上的假模型，不碰用户自己的会话、ssh 配置和密钥。
//
// 用法：node apps/mobile/scripts/fixture.mjs --out <配置文件> [--serve <端口>] [--adb]
//   --out    就绪后把连接配置写到这个文件（JSON：target、adapter、states、root）
//   --serve  在回环上开一个只读的 HTTP 口，GET /config 给出同一份配置：模拟器里的原型启动时从这里取
//   --adb    用 adb reverse 把 sshd 的端口和 --serve 的端口映射进模拟器（模拟器里连 127.0.0.1 就到这台电脑；
//            --serve 的端口映射成手机上的 8765）。有几台模拟器时用 ANDROID_SERIAL 指定是哪一台
// 一直运行到被结束，退出时夹具自己停掉 sshd 和设备服务、删掉临时目录。
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureEnvironment } from '../../../scripts/fixture-environment.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const arg = (name) => {
  const at = process.argv.indexOf(name)
  return at < 0 ? null : process.argv[at + 1]
}
const out = arg('--out')
const serve = arg('--serve')
const useAdb = process.argv.includes('--adb')
if (!out) {
  console.error('要给 --out')
  process.exit(2)
}

/** 读 ssh 配置里某个别名的那几项 */
function hostOptions(configText, alias) {
  const options = {}
  let inside = false
  for (const raw of configText.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const [key, ...rest] = line.split(/\s+/)
    if (key === 'Host') {
      inside = rest.includes(alias)
      continue
    }
    if (!inside) continue
    const value = rest.join(' ')
    if (key === 'SetEnv') {
      options.env = options.env ?? {}
      const [name, ...v] = value.split('=')
      options.env[name] = v.join('=')
    } else options[key] = value
  }
  return options
}

const child = spawn(process.execPath, [join(repo, 'scripts/client-ssh-fixture.mjs')], {
  cwd: repo,
  env: fixtureEnvironment(),
  stdio: ['ignore', 'pipe', 'inherit'],
})
const stop = () => child.kill('SIGTERM')
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
child.on('exit', (code) => process.exit(code ?? 0))

let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    const line = buffer.slice(0, newline)
    buffer = buffer.slice(newline + 1)
    if (line.startsWith('LITCH_SSH_FIXTURE '))
      ready(JSON.parse(line.slice('LITCH_SSH_FIXTURE '.length)))
    else if (line.trim()) console.log(`[夹具] ${line}`)
  }
})

function ready(fixture) {
  const options = hostOptions(readFileSync(fixture.config, 'utf8'), fixture.aliases.svc)
  const said = execFileSync(
    'ssh-keygen',
    ['-l', '-E', 'sha256', '-f', join(fixture.root, 'host_key.pub')],
    {
      encoding: 'utf8',
    },
  )
  const fingerprint = said.split(/\s+/)[1]
  const target = {
    host: options.HostName,
    port: Number(options.Port),
    user: options.User,
    privateKey: readFileSync(options.IdentityFile, 'utf8'),
    passphrase: '',
    hostFingerprint: fingerprint,
    env: options.env ?? {},
  }
  const config = {
    target,
    adapter: fixture.adapter,
    states: fixture.states,
    work: fixture.work,
    modelLog: fixture.modelLog,
    root: fixture.root,
  }
  writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`)
  legacyRemote(fixture)
  if (useAdb) {
    execFileSync('adb', ['reverse', `tcp:${target.port}`, `tcp:${target.port}`])
    // 应用固定从手机的 8765 取配置（src/shell/boot.ts），电脑这头的端口随意：几条开发线各用各的、互不相撞
    if (serve) execFileSync('adb', ['reverse', 'tcp:8765', `tcp:${serve}`])
  }
  if (serve) {
    createServer((req, res) => {
      if (req.url !== '/config') {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(config))
    }).listen(Number(serve), '127.0.0.1')
  }
  console.log(`LITCH_MOBILE_FIXTURE ${JSON.stringify({ out, port: target.port, serve })}`)
}

/**
 * 对照组（旧的 tyrs-hand 客户端）要的远端：它不带 LITCH_FX_MODE、不走登录 shell，sshd 用 zsh -c 执行它的命令，
 * zsh 总会读 ~/.zshenv。所以替身的目录写进夹具主目录的 .zshenv，只在没有 LITCH_FX_MODE 时加进 PATH，原型的连接不受影响。
 * 代理接到设备服务里 Pi 运行时的套接字上（设备服务要先由原型或 ssh-smoke 拉起来）。
 */
function legacyRemote(fixture) {
  const home = join(fixture.root, 'h')
  const bin = join(fixture.root, 'legacy-bin')
  mkdirSync(bin, { recursive: true })
  const script = join(repo, 'apps/mobile/scripts/legacy-remote.mjs')
  const sock = join(fixture.states.svc, 'pi', 'runtime.sock')
  const q = (text) => `'${text.replaceAll("'", `'\\''`)}'`
  const wrapper = (toolName) =>
    [
      '#!/bin/sh',
      `LEGACY_TOOL=${toolName} LEGACY_SOCK=${q(sock)} exec ${q(process.execPath)} ${q(script)} "$@"`,
      '',
    ].join('\n')
  writeFileSync(join(bin, 'tyrs-hand-worker'), wrapper('worker'))
  writeFileSync(join(bin, 'codex'), wrapper('codex'))
  chmodSync(join(bin, 'tyrs-hand-worker'), 0o755)
  chmodSync(join(bin, 'codex'), 0o755)
  writeFileSync(
    join(home, '.zshenv'),
    `if [ -z "$LITCH_FX_MODE" ]; then PATH=${q(bin)}:"$PATH"; export PATH; fi\n`,
  )
}
