// 认出本机的 Claude Code 原生会话里，哪些是 Claude 桌面端从另一个会话派出来的（扩展 nativeLineage，
// 规矩在 protocol/extensions/native-lineage.json）。
//
// 桌面端用 start_session 起的会话在原生记录里是普通的独立会话，记录里没有指向父会话的字段。认的办法只看记录本身：
// 第一行的 entrypoint 是 claude-desktop，而且第一条不是 isMeta 的用户消息里有桌面端写在派出简报前面的那句固定开头。
// 父会话是哪一个从记录里看不出来，这里只认“是派出来的”；父会话另从桌面端的数据目录里认（desktop-lineage.mts）。
// 用户在桌面端分叉、交接出来的会话开头是复制过来的原对话，这里认不出；桌面端记了父会话的仍算派出来的。
// 只读记录开头的一段，读不到、格式不对的一律当作不是。

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeLineageApp } from '../../protocol/src/native-lineage.mjs'

/** 桌面端写在派出简报前面的那句固定开头 */
export const DESKTOP_SPAWN_MARK = '(from the session that started this one)'
/** 记录开头读多少：第一条用户消息（系统提醒加简报）一般在几十 KB 以内 */
const HEAD_BYTES = 256 * 1024

/** 原生记录在哪：<配置目录>/projects/<项目目录>/<会话号>.jsonl。一次把要找的都找出来 */
export function findNativeRecords(
  configDir: string,
  sessionIds: readonly string[],
): Map<string, string> {
  const wanted = new Set(sessionIds.map((id) => `${id}.jsonl`))
  const found = new Map<string, string>()
  if (wanted.size === 0) return found
  const root = join(configDir, 'projects')
  let projects: string[]
  try {
    projects = readdirSync(root)
  } catch {
    return found
  }
  for (const project of projects) {
    let names: string[]
    try {
      names = readdirSync(join(root, project))
    } catch {
      continue
    }
    for (const name of names) {
      if (!wanted.has(name)) continue
      found.set(name.slice(0, -'.jsonl'.length), join(root, project, name))
    }
    if (found.size === wanted.size) break
  }
  return found
}

/** 记录开头那一段的完整行（最后一行可能被截断，丢掉） */
function headLines(path: string): string[] {
  let fd: number | null = null
  try {
    if (!statSync(path).isFile()) return []
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(HEAD_BYTES)
    const length = readSync(fd, buffer, 0, HEAD_BYTES, 0)
    const text = buffer.subarray(0, length).toString('utf8')
    const lines = text.split('\n')
    if (length === HEAD_BYTES) lines.pop()
    return lines
  } catch {
    return []
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** 一条用户消息里的字：字符串原样，块数组取各个文字块 */
function userText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) =>
      block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n')
}

/** 这份原生记录是谁派出来的。不是派出来的、认不出、读不到都回 null */
export function readNativeLineage(path: string): NativeLineageApp | null {
  let entrypoint: string | null = null
  for (const line of headLines(path)) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (entrypoint === null && typeof entry.entrypoint === 'string') entrypoint = entry.entrypoint
    if (entry.type !== 'user' || entry.isMeta === true) continue
    const message = entry.message as { content?: unknown } | undefined
    const text = userText(message?.content)
    return entrypoint === 'claude-desktop' && text.includes(DESKTOP_SPAWN_MARK)
      ? 'claude-desktop'
      : null
  }
  return null
}
