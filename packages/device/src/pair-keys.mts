// 扫码绑定手机用到的钥匙：一次性钥匙的生成、公钥行的解析、确认码与手机号与指纹的算法，
// 以及 authorized_keys 的读写（只在末尾追加、按行尾标记删行，其他字节不动）。
// 算法的定义和测试向量在 packages/protocol/src/device-pairing.mts。
import { createHash, generateKeyPairSync, randomBytes, randomInt } from 'node:crypto'
import {
  accessSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  PAIR_KEY_MARK,
  PAIR_PHONE_NAME_MAX,
  PHONE_KEY_MARK,
} from '../../protocol/src/device-pairing.mjs'

const ED25519 = 'ssh-ed25519'

// ---------- 公钥与算法 ----------

/** SSH 线格式的 string：4 字节大端长度加内容 */
function sshString(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(bytes.length)
  return Buffer.concat([length, bytes])
}

/** ed25519 公钥（32 字节）的 SSH 二进制：string "ssh-ed25519" + string 公钥 */
function ed25519Blob(publicKey: Buffer): Buffer {
  return Buffer.concat([sshString(Buffer.from(ED25519)), sshString(publicKey)])
}

/** 和 `ssh-keygen -l -E sha256` 一样：SHA256: 加无填充的标准 base64 */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}

/** 手机号：公钥二进制做 SHA-256，取前 8 字节的小写十六进制 */
export function phoneIdOf(blob: Buffer): string {
  return createHash('sha256').update(blob).digest().subarray(0, 8).toString('hex')
}

/** 确认码：SHA-256(配对号 + "\n" + 公钥行) 的前 4 字节按大端读，模 1000000，补零到 6 位 */
export function confirmCodeOf(
  pairId: string,
  publicKeyLine: string,
  approvalKey: string | null = null,
): string {
  // 手机带了批准公钥的，把它也算进去：人核对过确认码，就连它一起核对过了
  const text = `${pairId}\n${publicKeyLine}${approvalKey === null ? '' : `\n${approvalKey}`}`
  const digest = createHash('sha256').update(text, 'utf8').digest()
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

/**
 * 解析手机交来的公钥行："ssh-ed25519 <base64>"，不带注释、不带选项。
 * 二进制必须正好是 string "ssh-ed25519" + 32 字节的 string。不合格返回 null
 */
export function parseEd25519Line(line: string): { line: string; blob: Buffer } | null {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(line)
  if (!match?.[1]) return null
  const blob = Buffer.from(match[1], 'base64')
  // 解码对不上原文（夹着非法的填充之类）也不收
  if (blob.toString('base64') !== match[1]) return null
  const expected = ed25519Blob(blob.subarray(blob.length - 32))
  if (blob.length !== 51 || !blob.equals(expected)) return null
  return { line, blob }
}

/** 一把新的一次性钥匙：种子就是 JWK 的 d（base64url 无填充），公钥行给 authorized_keys 用 */
export function newOneTimeKey(): { seed: string; publicKeyLine: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const seed = privateKey.export({ format: 'jwk' }).d
  const x = publicKey.export({ format: 'jwk' }).x
  if (!seed || !x) throw new Error('生成 ed25519 钥匙失败')
  const blob = ed25519Blob(Buffer.from(x, 'base64url'))
  return { seed, publicKeyLine: `${ED25519} ${blob.toString('base64')}` }
}

const PAIR_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** 配对号：16 个字母数字。会写进 command= 和行尾注释，所以只用这些字符 */
export function newPairId(): string {
  let id = ''
  for (let i = 0; i < 16; i++) id += PAIR_ID_ALPHABET[randomInt(PAIR_ID_ALPHABET.length)]
  return id
}

/** 配对号的样子：外面传进来的 pairId 先过这一关，免得拿去拼标记时匹配到别的行 */
export function isPairId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9]{16}$/.test(value)
}

/** 手机号的样子 */
export function isPhoneId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)
}

/**
 * 手机名写进钥匙行注释之前的清洗：去掉控制字符和不可见的格式字符，空白换成下划线，
 * 截到 PAIR_PHONE_NAME_MAX 个 UTF-16 码元（不切开代理对）。清完是空的用 "phone"
 */
export function cleanPhoneName(name: string): string {
  let cleaned = name
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, (char) => (/\s/.test(char) ? ' ' : ''))
    .replace(/\s+/gu, ' ')
    .trim()
  if (cleaned.length > PAIR_PHONE_NAME_MAX) {
    cleaned = cleaned.slice(0, PAIR_PHONE_NAME_MAX)
    // 截在代理对中间时把落单的高位去掉
    if (/[\uD800-\uDBFF]$/.test(cleaned)) cleaned = cleaned.slice(0, -1)
  }
  return cleaned || 'phone'
}

// ---------- 钥匙行 ----------

/**
 * 一次性钥匙行。command 是已经按 shell 引好的命令（见 enrollCommand），expiry 是 expiry-time 的值，
 * 拿不准 sshd 版本时是 null，不加这一项
 */
export function oneTimeLine(
  pairId: string,
  publicKeyLine: string,
  command: string,
  expiry: string | null,
): string {
  // authorized_keys 的选项值里只有 \" 是转义，别的反斜杠原样保留
  const options = [
    'restrict',
    `command="${command.replaceAll('"', '\\"')}"`,
    ...(expiry ? [`expiry-time="${expiry}"`] : []),
  ]
  return `${options.join(',')} ${publicKeyLine} ${PAIR_KEY_MARK}${pairId}`
}

/**
 * 强制命令：适配器命令行的 pair-enroll 子命令。路径按登录 shell 的规矩引起来。
 * home 是适配器的状态目录：sshd 给强制命令的环境里没有 LITCH_DEVICE_SOCKET，不带它就只会去找默认的那个
 */
export function enrollCommand(cli: string, pairId: string, windows: boolean, home: string): string {
  const quote = (value: string) => (windows ? `"${value}"` : `'${value.replaceAll("'", `'\\''`)}'`)
  return `${quote(cli)} pair-enroll --home ${quote(home)} ${pairId}`
}

/** 手机行：不加选项，和普通 ssh 钥匙一样。日期是 UTC 的 YYYY-MM-DD */
export function phoneLine(
  publicKeyLine: string,
  phoneId: string,
  name: string,
  now: number,
): string {
  const date = new Date(now).toISOString().slice(0, 10)
  return `${publicKeyLine} ${PHONE_KEY_MARK}${phoneId} ${cleanPhoneName(name)} ${date}`
}

/** 一行（不含换行）去掉行尾的 \r 和空白 */
const tidy = (line: string) => line.replace(/\s+$/, '')

/** 这一行是不是某个配对（不给 pairId 就是任意配对）的一次性钥匙行 */
export function isPairLine(line: string, pairId?: string): boolean {
  const text = tidy(line)
  if (pairId !== undefined) return text.endsWith(` ${PAIR_KEY_MARK}${pairId}`)
  return new RegExp(`\\s${PAIR_KEY_MARK}[A-Za-z0-9]+$`).test(text)
}

export interface PhoneLineInfo {
  phoneId: string
  name: string
  fingerprint: string
  addedAt: number | null
}

/** 解析带 litch-mobile: 标记的手机行，不是返回 null */
export function parsePhoneLine(line: string): PhoneLineInfo | null {
  const tokens = tidy(line).trim().split(/\s+/)
  const at = tokens.findIndex((token) => token.startsWith(PHONE_KEY_MARK))
  if (at < 2 || tokens[at - 2] !== ED25519) return null
  const phoneId = (tokens[at] ?? '').slice(PHONE_KEY_MARK.length)
  if (!isPhoneId(phoneId)) return null
  const parsed = parseEd25519Line(`${ED25519} ${tokens[at - 1]}`)
  if (!parsed) return null
  // 名字可以带空格：手机号和行尾日期之间的都是名字
  const rest = tokens.slice(at + 1)
  const last = rest[rest.length - 1]
  const dated = last !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(last)
  const addedAt = dated ? Date.parse(`${last}T00:00:00Z`) : NaN
  return {
    phoneId,
    name: (dated ? rest.slice(0, -1) : rest).join(' '),
    fingerprint: fingerprintOf(parsed.blob),
    addedAt: Number.isNaN(addedAt) ? null : addedAt,
  }
}

/** 这一行里是不是这把公钥（base64 那一段作为一个词出现在钥匙类型后面） */
export function hasKey(line: string, keyBase64: string): boolean {
  const tokens = tidy(line).trim().split(/\s+/)
  for (let i = 1; i < tokens.length; i++)
    if (tokens[i] === keyBase64 && /^(ssh-|ecdsa-|sk-)/.test(tokens[i - 1] ?? '')) return true
  return false
}

// ---------- authorized_keys ----------

/** 钥匙文件不能改：符号链接、只读、属主不对、被锁着、写失败 */
export class KeysFileError extends Error {}

/** 别的 Litch 进程拿着锁超过这么久，算它死了留下的 */
const LOCK_STALE_MS = 10_000
/** 等锁最多等这么久 */
const LOCK_WAIT_MS = 3000
/** 写的途中文件被别人改了，重来几次 */
const EDIT_ATTEMPTS = 3

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** 按 \n 切成行，每行连着自己的 \n（最后一行可能没有）。字节原样，不经过解码 */
function splitLines(content: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let start = 0
  while (start < content.length) {
    const end = content.indexOf(0x0a, start)
    const stop = end < 0 ? content.length : end + 1
    lines.push(content.subarray(start, stop))
    start = stop
  }
  return lines
}

const sameFile = (a: Stats | null, b: Stats | null) =>
  a === null || b === null
    ? a === b
    : a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * 当前用户的 authorized_keys。改的规矩：加锁（同目录下的 <文件名>.litch-lock，只管 Litch 自己的几个进程）；
 * 读出原文件，只在末尾追加、或者整行删掉带标记的行，别的字节不动；写临时文件再改名，文件 600、新建的目录 700；
 * 改名前再看一眼原文件，被别人改过就重来。所有操作都是同步的：文件很小，同一进程里也就不会交错。
 */
export class AuthorizedKeys {
  readonly path: string
  private readonly posix: boolean

  constructor(path: string, platform: NodeJS.Platform = process.platform) {
    this.path = path
    this.posix = platform !== 'win32'
  }

  /** 能不能改。不能改抛 KeysFileError，说清楚为什么 */
  check(): void {
    const directory = dirname(this.path)
    const uid = this.posix ? process.getuid?.() : undefined
    const dirStat = statOrNull(directory)
    if (dirStat) {
      if (!dirStat.isDirectory()) throw new KeysFileError(`${directory} 不是目录`)
      if (uid !== undefined && dirStat.uid !== uid)
        throw new KeysFileError(`${directory} 的属主不是当前用户`)
      try {
        accessSync(directory, constants.W_OK)
      } catch {
        throw new KeysFileError(`${directory} 不可写`)
      }
    }
    let fileStat: Stats
    try {
      fileStat = lstatSync(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new KeysFileError(`读不了 ${this.path}：${String(error)}`)
    }
    if (fileStat.isSymbolicLink())
      throw new KeysFileError(
        `${this.path} 是符号链接，这台机器的钥匙文件由别的工具管理，请手动添加`,
      )
    if (!fileStat.isFile()) throw new KeysFileError(`${this.path} 不是普通文件`)
    if (uid !== undefined && fileStat.uid !== uid)
      throw new KeysFileError(`${this.path} 的属主不是当前用户`)
    // 只读的多半是被配置管理工具管着（NixOS、Ansible）；root 跑的时候 access 总说可写，所以也看权限位
    if (this.posix && (fileStat.mode & 0o200) === 0)
      throw new KeysFileError(`${this.path} 是只读的，这台机器的钥匙文件由别的工具管理，请手动添加`)
    try {
      accessSync(this.path, constants.W_OK)
    } catch {
      throw new KeysFileError(`${this.path} 不可写`)
    }
  }

  /** 原样读出来，没有这个文件是空的 */
  read(): Buffer {
    try {
      return readFileSync(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0)
      throw new KeysFileError(`读不了 ${this.path}：${String(error)}`)
    }
  }

  /** 各行的文本（不含换行） */
  lines(): string[] {
    return splitLines(this.read()).map((line) => line.toString('utf8').replace(/\r?\n$/, ''))
  }

  /** 在末尾追加一行。原文件最后没有换行的先补一个，原有的字节一个不动 */
  append(line: string): void {
    this.edit((content) => {
      const head = content.length > 0 && content[content.length - 1] !== 0x0a ? '\n' : ''
      return Buffer.concat([content, Buffer.from(`${head}${line}\n`, 'utf8')])
    })
  }

  /** 删掉 match 认的那些行（连着它的换行），返回删了几行。一行都不删就不碰文件 */
  remove(match: (line: string) => boolean): number {
    let removed = 0
    this.edit((content) => {
      const lines = splitLines(content)
      const kept = lines.filter((line) => !match(line.toString('utf8').replace(/\r?\n$/, '')))
      removed = lines.length - kept.length
      return removed === 0 ? null : Buffer.concat(kept)
    })
    return removed
  }

  /**
   * change 拿原内容算新内容，返回 null 是不用改。先不加锁算一遍：不用改的话什么都不碰
   * （设备进程启动时的清理多半是这样，不该为它在 ~/.ssh 里建锁文件）。要改才加锁、重读、再算、写。
   */
  private edit(change: (content: Buffer) => Buffer | null): void {
    if (change(this.read()) === null) return
    this.check()
    const directory = dirname(this.path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const release = this.lock()
    try {
      for (let attempt = 1; ; attempt++) {
        const before = statOrNull(this.path)
        const next = change(this.read())
        if (next === null) return
        const temp = `${this.path}.litch-${randomBytes(6).toString('hex')}.tmp`
        try {
          const fd = openSync(temp, 'wx', 0o600)
          try {
            writeSync(fd, next)
            fsyncSync(fd)
          } finally {
            closeSync(fd)
          }
          if (!sameFile(before, statOrNull(this.path))) {
            if (attempt >= EDIT_ATTEMPTS)
              throw new KeysFileError(`${this.path} 一直在被别的程序改，稍后再试`)
            continue
          }
          renameSync(temp, this.path)
          return
        } catch (error) {
          if (error instanceof KeysFileError) throw error
          throw new KeysFileError(`写不了 ${this.path}：${String(error)}`)
        } finally {
          rmSync(temp, { force: true })
        }
      }
    } finally {
      release()
    }
  }

  private lock(): () => void {
    const path = `${this.path}.litch-lock`
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        closeSync(openSync(path, 'wx', 0o600))
        return () => rmSync(path, { force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw new KeysFileError(`建不了锁文件 ${path}：${String(error)}`)
      }
      const held = statOrNull(path)
      if (held && Date.now() - held.mtimeMs > LOCK_STALE_MS) {
        try {
          unlinkSync(path)
        } catch {}
        continue
      }
      if (Date.now() >= deadline) throw new KeysFileError(`${this.path} 被别的 Litch 进程锁着`)
      sleepSync(50)
    }
  }
}
