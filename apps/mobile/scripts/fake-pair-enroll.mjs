// 端到端用例里假的 pair-enroll：扫码绑定时一次性钥匙登进夹具的 sshd 后跑的强制命令（scripts/e2e.mjs 的 /pair 写那一行）。
// 照约定（packages/protocol/src/device-pairing.mts）读标准输入一行、写回标准输出一行，中间演“电脑上点允许”：
// 收到登记就把手机名、确认码写进 <目录>/<配对号>.request，等 <目录>/<配对号>.decision 出现（allow 或 reject，入口脚本的小口写），
// 允许了就把手机的钥匙行追加进钥匙文件、删掉一次性钥匙那一行。真的设备进程合进来之前，手机这头的流程靠它验。
//
// 用法：node fake-pair-enroll.mjs <配对号> <钥匙文件> <目录>
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [pairId, keysFile, dir] = process.argv.slice(2)
const DECIDE_MS = 2 * 60 * 1000

const reply = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
  process.exit(0)
}
const fail = (error, message) => reply({ ok: false, error, message })

/** 读标准输入的第一行 */
function firstLine() {
  return new Promise((done) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      text += chunk
      const at = text.indexOf('\n')
      if (at >= 0) done(text.slice(0, at))
    })
    process.stdin.on('end', () => done(text))
  })
}

const sha256 = (data) => createHash('sha256').update(data).digest()

const line = await firstLine()
let input
try {
  input = JSON.parse(line)
} catch {
  fail('invalid', '不是 JSON')
}
if (input?.v !== 1) fail('invalid', '版本不对')
if (input.probe === true) reply({ ok: true, probe: true })
const publicKey = typeof input.publicKey === 'string' ? input.publicKey : ''
const [type, blob] = publicKey.split(' ')
if (type !== 'ssh-ed25519' || !blob || typeof input.name !== 'string')
  fail('invalid', '只收 ed25519')

const request = join(dir, `${pairId}.request`)
if (existsSync(request)) fail('used', '这个码已经有手机登记过了')
const digest = sha256(`${pairId}\n${publicKey}`)
const code = String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
const phoneId = sha256(Buffer.from(blob, 'base64')).subarray(0, 8).toString('hex')
writeFileSync(request, `${JSON.stringify({ name: input.name, code, phoneId, publicKey })}\n`)

const decision = join(dir, `${pairId}.decision`)
const started = Date.now()
while (!existsSync(decision)) {
  if (Date.now() - started > DECIDE_MS) fail('timeout', '电脑上没表态')
  await new Promise((done) => setTimeout(done, 200))
}
if (readFileSync(decision, 'utf8').trim() !== 'allow') fail('rejected', '电脑上拒绝了')

const date = new Date().toISOString().slice(0, 10)
const kept = readFileSync(keysFile, 'utf8')
  .split('\n')
  .filter((row) => row && !row.endsWith(`litch-pair:${pairId}`))
kept.push(`${publicKey} litch-mobile:${phoneId} ${input.name.replace(/\s+/g, '_')} ${date}`)
writeFileSync(keysFile, `${kept.join('\n')}\n`, { mode: 0o600 })
reply({ ok: true, phoneId })
