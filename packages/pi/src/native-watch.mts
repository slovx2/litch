import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { fileStamp } from './native-files.mjs'
import type { SessionManager } from './sdk.mjs'

// 核对“已经读过的部分没变”时重读的、它末尾那一段的字节数
const TAIL = 4096

/** 上一次核对到的地方：哪个文件、读过多长（停在行尾）、那一段末尾的字节、当时内存里有几个条目 */
interface Checked {
  path: string
  dev: bigint
  ino: bigint
  length: number
  tail: Buffer
  entries: number
}

// Pi 实例只能交替使用；执行中发现另一写入者后停止模型，要求显式重新加载。
//
// 文件一变就要核对它和内存里的条目是不是一回事，但不整份读：Pi 写会话文件只往末尾追加
// （SessionManager 里头一次有对话时用 "wx" 新建、把内存里的条目整份写进去，之后每个条目
// appendFileSync 一行 JSON.stringify(条目)；整份重写只在打开空文件、打开时迁移旧格式时，分叉写的是新文件），
// 所以记下上次读到哪儿，下次先核对那一处还在不在（同一个文件、没变短、末尾那段字节没变），
// 在就只读新增的那一截：每一行都得是内存里有的条目、内容一样，行数和内存里多出来的条目数一样。
// 核对不上就整份读一遍，和内存里的全部条目逐条比。
export function watchNativeSession(session: AgentSession, onConflict: () => void): () => void {
  let conflict = false
  let persisted = Boolean(session.sessionFile && existsSync(session.sessionFile))
  let stamp: string | null = null
  let checked: Checked | null = null
  const timer = setInterval(() => {
    if (conflict || !session.sessionFile) return
    const path = session.sessionFile
    const next = fileStamp(path)
    if (next === stamp && next !== null) return
    stamp = next
    if (next === null) {
      checked = null
      if (persisted) {
        conflict = true
        onConflict()
      }
      return
    }
    persisted = true
    checked = verify(path, session.sessionManager, checked)
    if (checked) return
    conflict = true
    onConflict()
  }, 25)
  timer.unref()
  return () => clearInterval(timer)
}

/** 文件和内存里的条目对得上就返回这次核对到的地方，对不上（或者读不了）返回 null */
function verify(path: string, manager: SessionManager, last: Checked | null): Checked | null {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return null
  }
  try {
    const info = fstatSync(fd, { bigint: true })
    const size = Number(info.size)
    const found = { path, dev: info.dev, ino: info.ino }
    if (
      last &&
      last.path === path &&
      last.dev === info.dev &&
      last.ino === info.ino &&
      size >= last.length
    ) {
      const from = last.length - last.tail.length
      const bytes = read(fd, from, size)
      if (bytes?.subarray(0, last.tail.length).equals(last.tail))
        return appended(found, manager, last, bytes, size)
    }
    const bytes = read(fd, 0, size)
    return bytes && whole(found, manager, bytes)
  } catch {
    // 写到一半的行、不是 JSON 的行：也是外面在改，不能接着往下写
    return null
  } finally {
    closeSync(fd)
  }
}

/** 读 [from, to)；文件在这期间变短了、读不满就是 null */
function read(fd: number, from: number, to: number): Buffer | null {
  const bytes = Buffer.allocUnsafe(to - from)
  let filled = 0
  while (filled < bytes.length) {
    const got = readSync(fd, bytes, filled, bytes.length - filled, from + filled)
    if (got === 0) return null
    filled += got
  }
  return bytes
}

/** 已读部分没变：只认新增的那一截。bytes 是从已读部分末尾那一段开始到文件末尾 */
function appended(
  found: Pick<Checked, 'path' | 'dev' | 'ino'>,
  manager: SessionManager,
  last: Checked,
  bytes: Buffer,
  size: number,
): Checked | null {
  const text = bytes.subarray(last.tail.length).toString('utf8')
  // 最后一行没有换行：有人写到一半
  if (text && !text.endsWith('\n')) return null
  const lines = text ? text.slice(0, -1).split('\n') : []
  for (const line of lines) {
    const entry = JSON.parse(line)
    const mine = typeof entry?.id === 'string' ? manager.getEntry(entry.id) : undefined
    if (!mine || JSON.stringify(entry) !== JSON.stringify(mine)) return null
  }
  // 每一行都是内存里有的条目还不够：照抄一行我们的条目再追加，行数就比内存里多出来的条目多了
  const entries = manager.getEntryCount()
  if (entries - last.entries !== lines.length) return null
  return { ...found, length: size, tail: tailOf(bytes), entries }
}

/** 整份比：和以前每次都做的一样，第一行是会话头，之后逐行和内存里的条目比 */
function whole(
  found: Pick<Checked, 'path' | 'dev' | 'ino'>,
  manager: SessionManager,
  bytes: Buffer,
): Checked | null {
  const text = bytes.toString('utf8')
  if (!text.endsWith('\n')) return null
  const disk = text
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line))
    .slice(1)
  const memory = manager.getEntries()
  if (
    disk.length !== memory.length ||
    disk.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(memory[index]))
  )
    return null
  return { ...found, length: bytes.length, tail: tailOf(bytes), entries: manager.getEntryCount() }
}

/** 末尾那一段另拷一份，不拖着整块读进来的内容 */
const tailOf = (bytes: Buffer): Buffer => Buffer.from(bytes.subarray(-Math.min(TAIL, bytes.length)))
