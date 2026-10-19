// 命令行 pair、pair-enroll 对着真的设备进程和真的 sshd 跑一遍端到端。
// 假的远程机器是 scripts/client-ssh-fixture.mjs：用户态的 sshd，svc 那个别名装着真的 Go 命令行，设备进程改的钥匙文件
// （LITCH_AUTHORIZED_KEYS）就是夹具 sshd 认的那一份，报的主机钥匙（LITCH_SSH_HOST_KEYS_DIR）就是夹具 sshd 的那一把。
// 这里扮两个角色：
//   用户：经夹具的 ssh 配置登到 svc，在终端（ssh -tt）里跑 pair，读它打的配对文本、确认码，回 y、n 或 Ctrl-C；
//   手机：解出配对文本里的种子写成临时私钥，钉住二维码里的主机指纹，用一次性钥匙登录，往标准输入写 PairEnrollInput，
//         核对 pair 打的确认码和按约定算出来的一样；登记成功后用手机自己的钥匙登录。
// 走五遍：允许、拒绝、Ctrl-C、没有终端时标准输入关了、终端断开（SIGHUP）。后三种结束后钥匙文件里不许留 litch-pair 行。
// 不碰这台电脑真的 ~/.ssh：ssh 客户端的 HOME 是临时目录，配置、known_hosts、钥匙都是夹具或这里临时建的，不用密钥代理。
//   要先 npm run build（根目录），并装好 packages/pi 的依赖（夹具要）。
//   npm run check:pair-cli
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))

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

// ---------- 约定里的算法（packages/protocol/src/device-pairing.mts），这里各算一遍 ----------

const sshString = (bytes) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  return Buffer.concat([length, bytes])
}

/** 确认码：SHA-256(配对号 + "\n" + 公钥行) 的前 4 字节大端读，模一百万，补到 6 位 */
const confirmCode = (pairId, publicKey) =>
  String(
    createHash('sha256').update(`${pairId}\n${publicKey}`).digest().readUInt32BE(0) % 1e6,
  ).padStart(6, '0')

/** 手机号：公钥二进制的 SHA-256 前 8 字节的十六进制 */
const phoneIdOf = (publicKey) =>
  createHash('sha256')
    .update(Buffer.from(publicKey.split(' ')[1], 'base64'))
    .digest()
    .subarray(0, 8)
    .toString('hex')

/** 指纹：和 ssh-keygen -l -E sha256 一样 */
const fingerprintOf = (publicKey) =>
  `SHA256:${createHash('sha256')
    .update(Buffer.from(publicKey.split(' ')[1], 'base64'))
    .digest('base64')
    .replace(/=+$/, '')}`

/** 32 字节种子写成 OpenSSH 格式（openssh-key-v1，不加密）的私钥，手机端要做的同一件事 */
function openSshPrivateKey(seedText) {
  const seed = Buffer.from(seedText, 'base64url')
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed])
  const jwk = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({
    format: 'jwk',
  })
  const pub = Buffer.from(jwk.x, 'base64url')
  const type = Buffer.from('ssh-ed25519')
  const check = randomBytes(4)
  let secret = Buffer.concat([
    check,
    check,
    sshString(type),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(Buffer.from('litch-pair')),
  ])
  const padding = []
  for (let i = 1; (secret.length + padding.length) % 8 !== 0; i++) padding.push(i)
  secret = Buffer.concat([secret, Buffer.from(padding)])
  const none = sshString(Buffer.from('none'))
  const count = Buffer.alloc(4)
  count.writeUInt32BE(1)
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    none,
    none,
    sshString(Buffer.alloc(0)),
    count,
    sshString(Buffer.concat([sshString(type), sshString(pub)])),
    sshString(secret),
  ]).toString('base64')
  const lines = body.match(/.{1,70}/g) ?? []
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`
}

const decodePayload = (text) =>
  JSON.parse(Buffer.from(text.slice('LITCHPAIR1:'.length), 'base64url').toString('utf8'))

// ---------- 夹具上的东西 ----------

const fixture = await startFixture()
/** 这里临时建的东西都在夹具的临时目录里，夹具收尾时一起删 */
const work = mkdtempSync(join(fixture.root, 'pc-'))
/** ssh 客户端的环境：HOME 换成临时目录，碰不到真的 ~/.ssh */
const env = { ...process.env, HOME: work, LANG: 'C', LC_ALL: 'C' }
const port = Number(/^\s+Port (\d+)$/m.exec(readFileSync(fixture.config, 'utf8'))?.[1])
const user = userInfo().username
const keysFile = join(fixture.root, 'authorized_keys')
const hostKey = readFileSync(join(fixture.root, 'host_key.pub'), 'utf8')
  .split(' ')
  .slice(0, 2)
  .join(' ')
const pairLines = () =>
  readFileSync(keysFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('litch-pair:'))

/** 还在跑的 pair（经 ssh）。一遍没过时把它停掉，免得它留下的一次性钥匙行拖累下一遍 */
const running = new Set()

/** 在 svc 上开一个终端跑 pair。tty 为 false 时不要终端（ssh -T） */
function startPair({ tty = true } = {}) {
  const remote = `. "$HOME/.profile" >/dev/null 2>&1; exec ${fixture.adapter} pair --host 127.0.0.1 --port ${port}`
  const child = spawn(
    'ssh',
    ['-F', fixture.config, tty ? '-tt' : '-T', fixture.aliases.svc, remote],
    {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const pair = { child, out: '' }
  running.add(child)
  child.once('exit', () => running.delete(child))
  child.stdout.on('data', (chunk) => {
    pair.out += chunk
  })
  child.stderr.on('data', (chunk) => {
    pair.out += chunk
  })
  pair.exited = new Promise((done) => child.once('exit', (code, signal) => done(code ?? signal)))
  /** 等输出里出现 pattern，返回匹配 */
  pair.expect = async (pattern, timeout = 60_000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      const found = pattern.exec(pair.out)
      if (found) return found
      if (Date.now() > deadline || child.exitCode !== null) {
        throw new Error(`等不到 ${pattern}，pair 的输出：\n${pair.out}`)
      }
      await new Promise((done) => setTimeout(done, 50))
    }
  }
  // pair 已经结束时再写会 EPIPE：吞掉，由断言报出来，不让整个脚本崩掉、跳过收尾
  child.stdin.on('error', () => {})
  pair.send = (text) => child.stdin.write(text)
  pair.exit = async (timeout = 30_000) => {
    const timer = new Promise((_, fail) =>
      setTimeout(() => fail(new Error(`pair 没有结束：\n${pair.out}`)), timeout),
    )
    return Promise.race([pair.exited, timer])
  }
  return pair
}

/** 手机：解出二维码，钉住主机指纹，写好一次性私钥 */
function scan(text) {
  const payload = decodePayload(text)
  assert.equal(payload.h, '127.0.0.1')
  assert.equal(payload.p, port)
  assert.equal(payload.u, user)
  assert.equal(payload.k.t, 'ssh-ed25519')
  // 二维码里的指纹就是夹具 sshd 那把主机钥匙的；手机只信它
  assert.equal(payload.k.f, fingerprintOf(hostKey), '二维码里的主机指纹不是夹具 sshd 的')
  const dir = mkdtempSync(join(work, 'phone-'))
  const knownHosts = join(dir, 'known_hosts')
  writeFileSync(knownHosts, `[127.0.0.1]:${port} ${hostKey}\n`)
  const once = join(dir, 'once')
  writeFileSync(once, openSshPrivateKey(payload.s), { mode: 0o600 })
  // 手机自己的钥匙
  const own = join(dir, 'own')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'phone', '-f', own])
  const publicKey = readFileSync(`${own}.pub`, 'utf8').split(' ').slice(0, 2).join(' ')
  return { payload, knownHosts, once, own, publicKey }
}

/** 手机的 ssh：钉住二维码里那一种主机钥匙算法，只用给的钥匙，不读任何配置 */
const phoneSsh = (phone, key) => [
  '-F',
  '/dev/null',
  '-T',
  '-p',
  String(port),
  '-l',
  user,
  '-i',
  key,
  '-o',
  'IdentitiesOnly=yes',
  '-o',
  'IdentityAgent=none',
  '-o',
  'BatchMode=yes',
  '-o',
  'PreferredAuthentications=publickey',
  '-o',
  `HostKeyAlgorithms=${phone.payload.k.t}`,
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  `UserKnownHostsFile=${phone.knownHosts}`,
  '-o',
  'GlobalKnownHostsFile=/dev/null',
  '-o',
  'UpdateHostKeys=no',
  '-o',
  'LogLevel=ERROR',
  '127.0.0.1',
]

/** 用一次性钥匙登录，写一行 PairEnrollInput，等那一行结果 */
function enroll(phone, name) {
  return new Promise((done) => {
    // 客户端要执行的命令写什么都没用，强制命令只跑 pair-enroll
    const child = spawn('ssh', [...phoneSsh(phone, phone.once), 'rm -rf /'], { env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.stdin.end(`${JSON.stringify({ v: 1, publicKey: phone.publicKey, name })}\n`)
    child.on('exit', (code) => {
      const line = stdout.split('\n').find((entry) => entry.startsWith('{'))
      done({ code, stdout, stderr, output: line ? JSON.parse(line) : null })
    })
  })
}

/** 用某把钥匙登录跑一条命令 */
const login = (phone, key) =>
  spawnSync('ssh', [...phoneSsh(phone, key), 'echo litch-phone-ok'], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })

const loginWorks = (phone, key) => login(phone, key).stdout.includes('litch-phone-ok')

// ---------- 五遍 ----------

/** 出码、自检通过、钥匙文件里多了一行一次性钥匙 */
async function newCode(pair) {
  const [text] = await pair.expect(/LITCHPAIR1:[A-Za-z0-9_-]+/)
  await pair.expect(/等手机扫码/)
  assert.match(pair.out, /自检通过/, `自检没过：\n${pair.out}`)
  assert.equal(pairLines().length, 1, '钥匙文件里应当正好有一行一次性钥匙')
  return scan(text)
}

/** 手机登记，pair 打出请求；核对确认码。返回还在等结果的登记 */
async function request(pair, phone, name) {
  const enrolling = enroll(phone, name)
  const [, a, b] = await pair.expect(/确认码 (\d{3}) (\d{3})/)
  assert.equal(
    `${a}${b}`,
    confirmCode(phone.payload.i, phone.publicKey),
    'pair 打的确认码和按约定算的不一样',
  )
  // 设备进程把名字里的空白换成下划线（写进钥匙行注释的也是这个名字）
  assert.match(pair.out, new RegExp(`手机“${name.replaceAll(' ', '_')}”请求绑定`))
  await pair.expect(/\[y\/N\]/)
  // 包一层：直接返回的话 await 会一直等到登记有结果，而结果要等这边回了 y 或 n 才有
  return { enrolling }
}

const steps = {
  async 允许() {
    const pair = startPair()
    const phone = await newCode(pair)
    const { enrolling } = await request(pair, phone, 'Pixel 8')
    pair.send('y\r')
    await pair.expect(/已允许/, 20_000)
    const { output, stderr } = await enrolling
    assert.deepEqual(
      output,
      { ok: true, phoneId: phoneIdOf(phone.publicKey) },
      `手机收到的：${stderr}`,
    )
    await pair.expect(/已绑定手机“Pixel_8”/)
    assert.equal(await pair.exit(), 0)
    assert.ok(
      loginWorks(phone, phone.own),
      `手机自己的钥匙登不进去：${login(phone, phone.own).stderr}`,
    )
    const denied = login(phone, phone.once)
    assert.ok(
      !denied.stdout.includes('litch-phone-ok') && /Permission denied/.test(denied.stderr),
      `一次性钥匙还能登录：${denied.stderr}`,
    )
    const keys = readFileSync(keysFile, 'utf8')
    assert.ok(
      keys.includes(`${phone.publicKey} litch-mobile:${phoneIdOf(phone.publicKey)} Pixel_8 `),
      keys,
    )
    assert.equal(pairLines().length, 0)
  },
  async 拒绝() {
    const pair = startPair()
    const phone = await newCode(pair)
    const { enrolling } = await request(pair, phone, 'Other Phone')
    pair.send('n\r')
    const { output } = await enrolling
    assert.equal(output?.ok, false)
    assert.equal(output?.error, 'rejected')
    await pair.expect(/已拒绝/)
    assert.equal(await pair.exit(), 1)
    assert.ok(!loginWorks(phone, phone.own), '拒绝了，手机的钥匙却能登录')
    assert.ok(!loginWorks(phone, phone.once), '拒绝了，一次性钥匙还能登录')
    assert.ok(!readFileSync(keysFile, 'utf8').includes(phone.publicKey))
    assert.equal(pairLines().length, 0)
  },
  async 'Ctrl-C'() {
    const pair = startPair()
    const phone = await newCode(pair)
    pair.send('\x03')
    await pair.expect(/已取消，一次性钥匙已删掉/)
    assert.equal(await pair.exit(), 130)
    assert.equal(pairLines().length, 0, '取消之后钥匙文件里还有一次性钥匙行')
    assert.ok(!loginWorks(phone, phone.once), '取消了，一次性钥匙还能登录')
  },
  async 标准输入关了() {
    const pair = startPair({ tty: false })
    await newCode(pair)
    pair.child.stdin.end()
    await pair.expect(/标准输入已经关了/)
    assert.equal(await pair.exit(), 1)
    assert.equal(pairLines().length, 0, '取消之后钥匙文件里还有一次性钥匙行')
  },
  async 终端断开() {
    const pair = startPair()
    await newCode(pair)
    // 本地的 ssh 没了，远端的终端挂断，pair 收到 SIGHUP
    pair.child.kill('SIGTERM')
    await pair.exit()
    const deadline = Date.now() + 15_000
    while (pairLines().length > 0 && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 100))
    assert.equal(pairLines().length, 0, '终端断开之后钥匙文件里还有一次性钥匙行')
  },
}

let failed = 0
try {
  for (const [name, step] of Object.entries(steps)) {
    try {
      await step()
      console.log(`✓ ${name}`)
    } catch (error) {
      failed++
      console.log(`✗ ${name}：${error instanceof Error ? error.message : String(error)}`)
      // 停掉留下的 pair（远端收到 SIGHUP 会取消配对），等一次性钥匙行删掉
      for (const child of running) child.kill('SIGTERM')
      const deadline = Date.now() + 15_000
      while ((running.size > 0 || pairLines().length > 0) && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 100))
      }
    }
  }
} finally {
  await fixture.stop()
}
console.log(
  failed === 0 ? '命令行扫码绑定的端到端：全部通过' : `命令行扫码绑定的端到端：${failed} 项没过`,
)
process.exit(failed === 0 ? 0 : 1)
