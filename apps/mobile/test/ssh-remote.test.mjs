// 远程那几段脚本（src/platform/ssh-script.ts）和照它们的输出定连哪一种（src/platform/ssh-probe.ts）。
// 脚本是真的交给本机的 sh 跑的：临时 HOME、SHELL=/bin/sh、PATH 里只有替身命令，不碰用户自己的 shell 配置。
// 手机端 SSH 模块的 runScript 由下面的 runLocally 顶替：把脚本喂给 sh，标记那一行之后才算脚本的输出（和 Go 那头一样）。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'
import { natives } from 'expo-modules-core'
import { sshFailure, sshProblem } from '../src/platform/ssh-errors.ts'
import { atLeast, decide, probe, startPeer, tailOf } from '../src/platform/ssh-probe.ts'
import { checkName, parsePairs, proxyScript } from '../src/platform/ssh-script.ts'

const root = mkdtempSync(join(tmpdir(), 'litch-mobile-ssh-'))
after(() => rmSync(root, { recursive: true, force: true }))
const home = join(root, 'home')
const bin = join(root, 'bin')
mkdirSync(home)

const names = { adapter: 'fx-adapter', codex: 'fx-codex', randomHex: () => '0123abcd' }
const config = { target: {}, adapter: names.adapter, codex: names.codex }
const live = { aborted: false }

/** 换一套替身命令：每个是一段 sh，$1 是子命令 */
function tools(scripts) {
  rmSync(bin, { recursive: true, force: true })
  mkdirSync(bin)
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
}

/**
 * 把脚本喂给 sh，extra 是标准输入里接在脚本后面的东西（代理那一步对面会读到它）。
 * 和 Go 那头（mobile/sshtransport/stream.go）一样，看到标记那一行才写 extra：dash 从管道读脚本是成块读的，
 * 早写进去的会被它一起读走
 */
function runLocally(script, marker, extra = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, SHELL: '/bin/sh' },
      cwd: home,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (child.stdin.writable && out.split('\n').some((line) => line.startsWith(marker)))
        child.stdin.end(extra)
    })
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      const lines = out.split('\n')
      const at = lines.findIndex((line) => line === marker || line.startsWith(`${marker} `))
      resolve({
        marked: at >= 0,
        peer: at >= 0 ? lines[at].slice(marker.length + 1) : '',
        output: at >= 0 ? lines.slice(at + 1).join('\n') : '',
        code: code ?? -1,
        stderr: err,
      })
    })
    child.stdin.write(script)
    if (!extra) child.stdin.end()
  })
}

beforeEach(() => {
  natives.LitchSsh = {
    async runScript(_target, script, marker) {
      return JSON.stringify(await runLocally(script, marker))
    },
  }
})

const adapter = ({
  version = 'codex-harness-adapter 0.8.0',
  running = false,
  start = '',
} = {}) => ({
  [names.adapter]: [
    'case "$1" in',
    `  version) echo '${version}' ;;`,
    `  device-proxy) ${running ? 'exit 0' : 'exit 1'} ;;`,
    `  device-start) ${start || `echo '{"ready":true}'`} ;;`,
    'esac',
  ].join('\n'),
})

test('探测：装了适配器，服务没在跑', async () => {
  tools(adapter())
  const found = await probe(config, names, live)
  assert.deepEqual(
    { ...found, system: typeof found.system },
    {
      peer: 'service',
      version: '0.8.0',
      running: false,
      system: 'string',
    },
  )
})

test('探测：适配器的服务在跑；两样都在时先认适配器', async () => {
  tools({ ...adapter({ running: true }), [names.codex]: 'echo "codex-cli 0.130.0"' })
  const found = await probe(config, names, live)
  assert.equal(found.peer, 'service')
  assert.equal(found.running, true)
})

test('探测：只装了 Litch 桌面端（适配器在应用包里），先认它而不是原生 codex', async () => {
  const bundled = join(home, 'Applications/Litch.app/Contents/Resources/adapter/bin')
  mkdirSync(bundled, { recursive: true })
  const stand = adapter({ running: true })[names.adapter]
  writeFileSync(join(bundled, names.adapter), `#!/bin/sh\n${stand}\n`)
  chmodSync(join(bundled, names.adapter), 0o755)
  try {
    tools({ [names.codex]: 'echo "codex-cli 0.130.0"' })
    const found = await probe(config, names, live)
    assert.equal(found.peer, 'service')
    assert.equal(found.running, true)
  } finally {
    rmSync(join(home, 'Applications'), { recursive: true, force: true })
  }
})

test('探测：只有原生 codex；版本太低的说清楚是哪一版', async () => {
  tools({ [names.codex]: 'echo "codex-cli 0.130.0-alpha.2"' })
  assert.equal((await probe(config, names, live)).peer, 'codex')
  assert.equal((await probe(config, names, live)).version, '0.130.0-alpha.2')
  tools({ [names.codex]: 'echo "codex-cli 0.99.1"' })
  await assert.rejects(probe(config, names, live), (error) => {
    assert.equal(error.stage, 'outdated')
    assert.equal(error.guide, 'upgradeCodex')
    assert.deepEqual(error.text, {
      key: 'remote.outdated',
      args: { version: '0.99.1', min: '0.125.0' },
    })
    return true
  })
})

test('探测：什么都没装，给安装指引而不是报错原文', async () => {
  tools({})
  await assert.rejects(probe(config, names, live), (error) => {
    assert.equal(error.stage, 'notInstalled')
    assert.equal(error.guide, 'install')
    assert.equal(error.retriable, false)
    return true
  })
})

test('探测：适配器太旧（不认 version）时带上它的原话', async () => {
  tools({ [names.adapter]: 'echo "unknown command: $1" >&2; exit 2' })
  await assert.rejects(probe(config, names, live), (error) => {
    assert.equal(error.stage, 'outdated')
    assert.equal(error.guide, 'upgradeService')
    assert.match(error.detail, /unknown command: version/)
    return true
  })
})

test('探测：内层脚本没跑起来（没打出标记）算连不到、可以重试', async () => {
  natives.LitchSsh.runScript = async () =>
    JSON.stringify({
      marked: false,
      output: '',
      code: 255,
      stderr: 'sh: no job control in this shell\n断了',
    })
  await assert.rejects(probe(config, names, live), (error) => {
    assert.equal(error.stage, 'unreachable')
    assert.equal(error.retriable, true)
    assert.equal(error.detail, '断了', '无关的那句抱怨去掉了')
    return true
  })
})

test('探测完发现已经取消了：不往下走', async () => {
  tools(adapter())
  await assert.rejects(probe(config, names, { aborted: true }), (error) => {
    assert.deepEqual(error.text, { key: 'connect.cancelled' })
    return true
  })
})

test('启动服务：报了 ready 就成；旧服务在跑（退出码 3）要人处理；别的失败带原话', async () => {
  tools(adapter())
  await startPeer(config, names, 'service', live)
  tools(adapter({ start: 'echo "旧的服务还在跑"; exit 3' }))
  await assert.rejects(startPeer(config, names, 'service', live), (error) => {
    assert.equal(error.stage, 'outdated')
    assert.equal(error.guide, 'restartService')
    assert.equal(error.detail, '旧的服务还在跑')
    return true
  })
  tools(adapter({ start: 'echo "端口被占了"; exit 1' }))
  await assert.rejects(startPeer(config, names, 'service', live), (error) => {
    assert.equal(error.stage, 'startFailed')
    assert.equal(error.retriable, true)
    assert.equal(error.detail, '端口被占了')
    return true
  })
  tools({})
  await assert.rejects(startPeer(config, names, 'service', live), { stage: 'notInstalled' })
})

test('启动原生 codex：已经在听就什么都不做', async () => {
  tools({ [names.codex]: '[ "$1 $2" = "app-server proxy" ] && exit 0; exit 9' })
  await startPeer(config, names, 'codex', live)
})

test('代理：先认适配器；脚本整段读完才执行，后面的标准输入原样交给代理', async () => {
  tools({ [names.adapter]: '[ "$1" = device-proxy ] && exec cat' })
  const script = proxyScript(names, 'auto')
  const result = await runLocally(script.text, script.marker, 'ping\n')
  assert.equal(result.peer, 'service')
  assert.equal(result.output, 'ping\n')
  tools({ [names.codex]: '[ "$1 $2" = "app-server proxy" ] && exec cat' })
  const native = await runLocally(script.text, script.marker, 'pong\n')
  assert.equal(native.peer, 'codex')
  assert.equal(native.output, 'pong\n')
})

test('命令名只许是一个不带空白和引号的名字或路径', () => {
  assert.equal(checkName('/opt/bin/codex-harness-adapter'), '/opt/bin/codex-harness-adapter')
  for (const bad of ['a b', "it's", '-rf', 'a;b', '$(x)', ''])
    assert.throws(() => checkName(bad), /不是一个合规的命令名/)
})

test('键值输出：同一个键出现多次连成多行，没有等号的行不要', () => {
  assert.deepEqual(parsePairs('a=1\nsaid=第一行\n杂音\nsaid=第二行\n=x\nb=c=d\n'), {
    a: '1',
    said: '第一行\n第二行',
    b: 'c=d',
  })
})

test('版本比较只看前三段数字', () => {
  assert.equal(atLeast('0.125.0', '0.125.0'), true)
  assert.equal(atLeast('0.125.0-alpha.1', '0.125.0'), true)
  assert.equal(atLeast('0.124.9', '0.125.0'), false)
  assert.equal(atLeast('1.0.0', '0.125.0'), true)
  assert.equal(atLeast('坏的', '0.1.0'), false)
  assert.equal(tailOf('cannot set terminal process group\n'), null)
  assert.throws(() => decide({ adapter: 'yes', adapterVersion: 'codex-harness-adapter 0.5.9' }), {
    stage: 'outdated',
  })
})

test('SSH 报错：按 Go 那头写在方括号里的种类认，前面多几层包装也认得出', () => {
  const wrapped = new Error(
    'Call to function LitchSsh.runScript has been rejected.\n→ Caused by: [hostKeyChanged] 主机钥匙变了',
  )
  assert.deepEqual(sshProblem(wrapped), {
    kind: 'hostKeyChanged',
    message: '[hostKeyChanged] 主机钥匙变了',
  })
  const cases = [
    ['[hostKeyUnknown] x', 'hostKey', false],
    ['[auth] x', 'auth', false],
    ['[keyLocked] x', 'auth', false],
    ['[invalid] x', 'unreachable', false],
    ['[unreachable] x', 'unreachable', true],
    ['认不出来的话', 'unreachable', true],
  ]
  for (const [said, stage, retriable] of cases) {
    const error = sshFailure(new Error(said))
    assert.equal(error.stage, stage, said)
    assert.equal(error.retriable, retriable, said)
  }
  assert.equal(sshFailure('认不出来的话').detail, '认不出来的话')
})
