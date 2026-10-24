// 扫码绑定手机的钥匙：算法钉住测试向量，钥匙文件只在末尾追加、按标记删行，原有字节一个不动。
import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { PAIR_PHONE_NAME_MAX } from '../../protocol/src/device-pairing.mjs'
import {
  expiryTime,
  parseOpenSshVersion,
  preferredHostKey,
  readHostKeys,
} from '../src/pair-host.mjs'
import {
  AuthorizedKeys,
  cleanPhoneName,
  confirmCodeOf,
  enrollCommand,
  fingerprintOf,
  hasKey,
  isPairLine,
  KeysFileError,
  newOneTimeKey,
  newPairId,
  oneTimeLine,
  parseEd25519Line,
  parsePhoneLine,
  phoneIdOf,
  phoneLine,
} from '../src/pair-keys.mjs'
import { tempDir } from './helpers.mjs'
import { fakeHostKey, phoneKey } from './pair-kit.mjs'

const posix = process.platform !== 'win32'

test('确认码、手机号、指纹和约定里的测试向量一致', () => {
  const line = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'
  const parsed = parseEd25519Line(line)
  assert.ok(parsed)
  assert.equal(confirmCodeOf('Ab3dEf6hIj9kLm2n', line), '965093')
  assert.equal(
    confirmCodeOf('Ab3dEf6hIj9kLm2n', line, 'ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ='),
    '977558',
  )
  assert.equal(phoneIdOf(parsed.blob), 'f83898df0bef57a4')
  assert.equal(fingerprintOf(parsed.blob), 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU')
})

test('只收不带注释的 ed25519 公钥行', () => {
  const good = phoneKey()
  assert.ok(parseEd25519Line(good))
  assert.equal(parseEd25519Line(`${good} phone`), null)
  assert.equal(parseEd25519Line(good.replace('ssh-ed25519', 'ssh-rsa')), null)
  assert.equal(parseEd25519Line('ssh-ed25519 AAAA'), null)
  // 类型名对、但二进制里的类型不是 ed25519
  assert.equal(parseEd25519Line(`ssh-ed25519 ${fakeHostKey('ssh-rsa').split(' ')[1]}`), null)
})

test('一次性钥匙：种子就是 ed25519 私钥，公钥行和它对得上', () => {
  const key = newOneTimeKey()
  assert.match(key.seed, /^[A-Za-z0-9_-]{43}$/)
  // 用 PKCS#8 的固定前缀把 32 字节种子还原成私钥，再算公钥
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(key.seed, 'base64url'),
  ])
  const x = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({
    format: 'jwk',
  }).x
  const parsed = parseEd25519Line(key.publicKeyLine)
  assert.ok(parsed)
  assert.equal(parsed.blob.subarray(19).toString('base64url'), x)
  assert.match(newPairId(), /^[A-Za-z0-9]{16}$/)
  assert.notEqual(newPairId(), newPairId())
})

test('钥匙行的样子：强制命令按 shell 引好，选项值里的双引号转义', () => {
  const key = phoneKey()
  assert.equal(
    oneTimeLine(
      'Ab3dEf6hIj9kLm2n',
      key,
      enrollCommand('/opt/x/litch', 'Ab3dEf6hIj9kLm2n', false, '/home/u/.codex-harness-adapter'),
      '20261019101000Z',
    ),
    `restrict,command="'/opt/x/litch' pair-enroll --home '/home/u/.codex-harness-adapter' Ab3dEf6hIj9kLm2n",expiry-time="20261019101000Z" ${key} litch-pair:Ab3dEf6hIj9kLm2n`,
  )
  assert.equal(
    oneTimeLine('Ab3dEf6hIj9kLm2n', key, 'c', null),
    `restrict,command="c" ${key} litch-pair:Ab3dEf6hIj9kLm2n`,
  )
  assert.equal(
    enrollCommand("/a b/it's", 'X', false, "/h o/me's"),
    `'/a b/it'\\''s' pair-enroll --home '/h o/me'\\''s' X`,
  )
  assert.equal(
    oneTimeLine(
      'X',
      key,
      enrollCommand('C:\\Program Files\\litch.exe', 'X', true, 'C:\\Users\\u\\.cha'),
      null,
    ),
    `restrict,command="\\"C:\\Program Files\\litch.exe\\" pair-enroll --home \\"C:\\Users\\u\\.cha\\" X" ${key} litch-pair:X`,
  )
  assert.ok(isPairLine(`... litch-pair:Ab3dEf6hIj9kLm2n\r`, 'Ab3dEf6hIj9kLm2n'))
  assert.ok(!isPairLine('... litch-pair:Ab3dEf6hIj9kLm2nX', 'Ab3dEf6hIj9kLm2n'))
  assert.ok(isPairLine('... litch-pair:Zz'))
  assert.ok(!isPairLine('ssh-ed25519 AAAA me@litch-pair:host'))
})

test('手机行：名字清洗、日期、解析回来', () => {
  const key = phoneKey()
  const parsed = parseEd25519Line(key)
  assert.ok(parsed)
  const id = phoneIdOf(parsed.blob)
  const now = Date.parse('2026-10-19T23:30:00Z')
  const line = phoneLine(key, id, ' Pixel 8\tPro\u200b\u0007 ', now)
  assert.equal(line, `${key} litch-mobile:${id} Pixel 8 Pro 2026-10-19`)
  assert.deepEqual(parsePhoneLine(line), {
    phoneId: id,
    name: 'Pixel 8 Pro',
    fingerprint: fingerprintOf(parsed.blob),
    addedAt: Date.parse('2026-10-19T00:00:00Z'),
  })
  assert.equal(parsePhoneLine(`${key} me@laptop`), null)
  assert.ok(hasKey(`from="1.2.3.4" ${key} me`, key.split(' ')[1] ?? ''))
  assert.equal(cleanPhoneName('\u0000\u202e'), 'phone')
  assert.equal(cleanPhoneName('小米  15'), '小米 15')
  const long = cleanPhoneName(`${'a'.repeat(PAIR_PHONE_NAME_MAX - 1)}😀`)
  assert.equal(long, 'a'.repeat(PAIR_PHONE_NAME_MAX - 1))
})

test('主机钥匙按 ed25519 > ecdsa > rsa 选，坏文件跳过', () => {
  const dir = tempDir()
  try {
    assert.deepEqual(readHostKeys(join(dir, 'none')), [])
    writeFileSync(join(dir, 'ssh_host_rsa_key.pub'), fakeHostKey('ssh-rsa'))
    writeFileSync(join(dir, 'ssh_host_dsa_key.pub'), fakeHostKey('ssh-dss'))
    writeFileSync(join(dir, 'ssh_host_bad_key.pub'), 'ssh-ed25519 !!!')
    writeFileSync(join(dir, 'ssh_host_ed25519_key'), 'private, not read')
    assert.equal(preferredHostKey(readHostKeys(dir))?.type, 'ssh-rsa')
    writeFileSync(join(dir, 'ssh_host_ecdsa_key.pub'), fakeHostKey('ecdsa-sha2-nistp256'))
    assert.equal(preferredHostKey(readHostKeys(dir))?.type, 'ecdsa-sha2-nistp256')
    const ed = fakeHostKey('ssh-ed25519')
    writeFileSync(join(dir, 'ssh_host_ed25519_key.pub'), ed)
    const keys = readHostKeys(dir)
    assert.deepEqual(
      keys.map((key) => key.type),
      ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa', 'ssh-dss'],
    )
    assert.equal(keys[0]?.publicKey, ed.split(' ').slice(0, 2).join(' '))
    assert.match(keys[0]?.fingerprint ?? '', /^SHA256:[A-Za-z0-9+/]{43}$/)
    rmSync(join(dir, 'ssh_host_ed25519_key.pub'))
    rmSync(join(dir, 'ssh_host_ecdsa_key.pub'))
    rmSync(join(dir, 'ssh_host_rsa_key.pub'))
    assert.equal(preferredHostKey(readHostKeys(dir)), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sshd 版本与 expiry-time', () => {
  assert.deepEqual(parseOpenSshVersion('OpenSSH_10.2p1, LibreSSL 3.3.6'), [10, 2])
  assert.deepEqual(parseOpenSshVersion('unknown option -- V\nOpenSSH_8.2p1 Ubuntu'), [8, 2])
  assert.deepEqual(parseOpenSshVersion('OpenSSH_for_Windows_9.5p1'), [9, 5])
  assert.equal(parseOpenSshVersion('dropbear'), null)
  const at = Date.parse('2026-10-19T10:05:07Z')
  assert.equal(expiryTime([9, 1], at), '20261019100507Z')
  assert.equal(expiryTime(null, at), null)
  assert.equal(expiryTime([8, 1], at), null)
  // 8.2 到 9.0 写本地时间，多放一天
  const local = new Date(at + 86_400_000)
  const pad = (n: number) => String(n).padStart(2, '0')
  assert.equal(
    expiryTime([8, 9], at),
    `${local.getFullYear()}${pad(local.getMonth() + 1)}${pad(local.getDate())}${pad(local.getHours())}${pad(local.getMinutes())}${pad(local.getSeconds())}`,
  )
})

/** 一份“用户原来的”钥匙文件：CRLF、注释、空行、UTF-8、最后一行没有换行 */
const ORIGINAL = Buffer.concat([
  Buffer.from('# 我的钥匙\r\nssh-ed25519 AAAAoriginal me@laptop\r\n\n'),
  Buffer.from('from="10.0.0.0/8" ssh-rsa AAAAother 名字 with spaces  \n'),
  Buffer.from([0xff, 0xfe, 0x20, 0x61]),
  Buffer.from('\nssh-ed25519 AAAAlast no-newline'),
])

function keysIn(dir: string): AuthorizedKeys {
  return new AuthorizedKeys(join(dir, 'ssh', 'authorized_keys'))
}

test('钥匙文件：追加、删行时原有的字节一个不动，文件 600、新建的目录 700', () => {
  const dir = tempDir()
  try {
    const keys = keysIn(dir)
    mkdirSync(dirname(keys.path), { mode: 0o755 })
    writeFileSync(keys.path, ORIGINAL, { mode: 0o644 })
    keys.append('restrict ssh-ed25519 AAAAone litch-pair:AAAAAAAAAAAAAAAA')
    keys.append('ssh-ed25519 AAAAphone litch-mobile:0123456789abcdef 手机 2026-10-19')
    const after = readFileSync(keys.path)
    assert.ok(after.subarray(0, ORIGINAL.length).equals(ORIGINAL))
    assert.equal(
      after.subarray(ORIGINAL.length).toString('utf8'),
      '\nrestrict ssh-ed25519 AAAAone litch-pair:AAAAAAAAAAAAAAAA\nssh-ed25519 AAAAphone litch-mobile:0123456789abcdef 手机 2026-10-19\n',
    )
    if (posix) {
      assert.equal(statSync(keys.path).mode & 0o777, 0o600)
      // 已有的目录不改权限
      assert.equal(statSync(dirname(keys.path)).mode & 0o777, 0o755)
    }
    assert.equal(
      keys.remove((line) => isPairLine(line)),
      1,
    )
    assert.equal(
      keys.remove((line) => line.includes('litch-mobile:0123456789abcdef')),
      1,
    )
    // 只剩原文件和补的那个换行
    assert.ok(readFileSync(keys.path).equals(Buffer.concat([ORIGINAL, Buffer.from('\n')])))
    // 没有临时文件、锁文件留下
    assert.deepEqual(readdirSync(dirname(keys.path)), ['authorized_keys'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('钥匙文件：没有就建，目录 700；不用改时什么都不碰', () => {
  const dir = tempDir()
  try {
    const keys = keysIn(dir)
    assert.equal(
      keys.remove(() => true),
      0,
    )
    assert.equal(existsSync(dirname(keys.path)), false)
    keys.append('ssh-ed25519 AAAAx litch-pair:BBBBBBBBBBBBBBBB')
    assert.equal(readFileSync(keys.path, 'utf8'), 'ssh-ed25519 AAAAx litch-pair:BBBBBBBBBBBBBBBB\n')
    if (posix) {
      assert.equal(statSync(dirname(keys.path)).mode & 0o777, 0o700)
      assert.equal(statSync(keys.path).mode & 0o777, 0o600)
    }
    const before = statSync(keys.path)
    assert.equal(
      keys.remove((line) => line.includes('nothing')),
      0,
    )
    assert.equal(statSync(keys.path).mtimeMs, before.mtimeMs)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('钥匙文件：符号链接、只读的不改，报 KeysFileError，原文件不变', { skip: !posix }, () => {
  const dir = tempDir()
  try {
    const keys = keysIn(dir)
    mkdirSync(dirname(keys.path), { mode: 0o700 })
    const real = join(dir, 'managed_keys')
    writeFileSync(real, ORIGINAL)
    symlinkSync(real, keys.path)
    assert.throws(() => keys.check(), KeysFileError)
    assert.throws(() => keys.append('x litch-pair:CCCCCCCCCCCCCCCC'), /符号链接/)
    assert.ok(readFileSync(real).equals(ORIGINAL))
    // 读还是能读的（列已绑定的手机用）
    assert.equal(keys.lines().length, 6)
    rmSync(keys.path)
    writeFileSync(keys.path, ORIGINAL, { mode: 0o400 })
    assert.throws(() => keys.append('x litch-pair:CCCCCCCCCCCCCCCC'), /只读/)
    assert.ok(readFileSync(keys.path).equals(ORIGINAL))
    chmodSync(keys.path, 0o600)
    keys.check()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('钥匙文件：别的 Litch 进程拿着锁时等，锁太旧了当它死了', () => {
  const dir = tempDir()
  try {
    const keys = keysIn(dir)
    mkdirSync(dirname(keys.path), { mode: 0o700 })
    const lock = `${keys.path}.litch-lock`
    writeFileSync(lock, '')
    const started = Date.now()
    assert.throws(() => keys.append('a litch-pair:DDDDDDDDDDDDDDDD'), /锁着/)
    assert.ok(Date.now() - started >= 2500)
    assert.equal(existsSync(keys.path), false)
    // 改成 11 秒前建的
    const old = new Date(Date.now() - 11_000)
    utimesSync(lock, old, old)
    keys.append('a litch-pair:DDDDDDDDDDDDDDDD')
    assert.equal(existsSync(lock), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
