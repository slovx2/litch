import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

// CHA_CLAUDE_PLANS_LOCATION=config 时计划文件在各会话共用的 `<配置目录>/plans/` 里，文件名是 CLI 给每个会话
// 起的 slug（主会话 `<slug>.md`）。入口事先不知道它：CLI 进入计划模式、头一次要计划文件路径时起名，
// 之后会话记录的每一行都带着 `"slug":"…"`（恢复会话时也是从记录里认回来的）。PreToolUse 钩子带着会话记录的
// 路径，从末尾往回找最后一个就是这个会话现在的 slug。CLI 攒一阵才写一批，刚进计划模式时那几行可能还没落盘，
// 找不到就稍等再看。

/** 末尾读这么多；slug 在每一行上，末尾找不到再整份读 */
const TAIL_BYTES = 1 << 20
const SLUG = /^[A-Za-z0-9_-]{1,128}$/

/**
 * 从后往前逐行解析，只认每行顶层的 slug 字段：工具参数、消息正文里出现的同名键不算
 * （不然模型在工具参数里写一个 slug 就能指定要豁免的文件）
 */
function slugIn(text: string): string | null {
  const lines = text.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (!line.includes('"slug"')) continue
    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      if (typeof entry.slug === 'string' && SLUG.test(entry.slug)) return entry.slug
    } catch {}
  }
  return null
}

function lastSlug(path: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    for (const length of size > TAIL_BYTES ? [TAIL_BYTES, size] : [size]) {
      const buffer = Buffer.alloc(length)
      const read = readSync(fd, buffer, 0, length, size - length)
      const found = slugIn(buffer.subarray(0, read).toString('utf8'))
      if (found) return found
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** 会话记录里这个会话的计划 slug；等到 waitMs 还没有就是 null */
export async function transcriptPlanSlug(path: string, waitMs = 3_000): Promise<string | null> {
  const deadline = Date.now() + waitMs
  for (;;) {
    const slug = lastSlug(path)
    if (slug || Date.now() >= deadline) return slug
    await delay(50)
  }
}
