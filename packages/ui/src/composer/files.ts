// 往消息里加不是图片的文件。协议的输入里没有“文件附件”，带得过去的办法只有两种：
// - 按路径提到它（发出去是 mention，或者路径写进正文）：harness 得读得到这个路径，
//   所以只有消息是发给本机设备、外壳又给得出文件在磁盘上的位置时才行；
// - 把内容读出来当一段文字带上：只有文本文件行，本机远程都一样。
// 两样都不行的（远程设备上的二进制文件、目录）当场说明，不做一个发出去对面读不到的东西；也不替用户往设备上传文件。
// 纯逻辑：test/files.test.mjs 直接引这个文件，所以只用可擦除的语法、不引样式和组件。
import type { MessageExtra } from '@litch/core'
import { TEXT_LIMIT, tidyText } from './extras.ts'

/**
 * 没带成的原因：
 * binary 不是文本，内容带不了（这时也没法按路径提到它）；size 内容太长；empty 是空的；
 * read 读不出来（多半是个目录）；count 这条消息带的东西已经满了
 */
export type FileRefusal = 'binary' | 'size' | 'empty' | 'read' | 'count'

export interface FileFacts {
  /** 消息是发给本机设备的：harness 和这个界面在同一台机器上，读得到同样的路径 */
  local: boolean
  /** 文件在磁盘上的位置。拿不到（不在桌面外壳里、文件不是从磁盘来的）就是空的 */
  pathOf(file: File): string
  /** 还能带几样 */
  room: number
}

export interface FilesResult {
  extras: MessageExtra[]
  /** 有文件没带成时，第一个没带成的是哪个、为什么 */
  refused: { why: FileRefusal; name: string } | null
}

/** 一个文件怎么带。ref：按路径提到它；inline：读出内容当文字带 */
export const planFile = (local: boolean, path: string): 'ref' | 'inline' =>
  local && path !== '' ? 'ref' : 'inline'

/** 路径的最后一段 */
export const baseName = (path: string): string =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path

/** 一段字节是不是文本：按 UTF-8 解得出来，里面没有 NUL。是的话给出文字 */
export function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.includes('\0') ? null : text
  } catch {
    return null
  }
}

/** 读一个文件的内容当文字带。UTF-8 里一个字符最多四个字节，比这还大的不用读就知道太长 */
async function inlineFile(file: File): Promise<MessageExtra | FileRefusal> {
  if (file.size > TEXT_LIMIT * 4) return 'size'
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    return 'read'
  }
  const decoded = decodeText(bytes)
  if (decoded === null) return 'binary'
  const text = tidyText(decoded)
  if (text.trim() === '') return 'empty'
  if (text.length > TEXT_LIMIT) return 'size'
  return { kind: 'text', name: file.name || null, text }
}

/** 把选中、拖进来、贴进来的文件（已经把图片挑出去了）变成随消息带的东西 */
export async function readFiles(files: File[], facts: FileFacts): Promise<FilesResult> {
  const extras: MessageExtra[] = []
  let refused: FilesResult['refused'] = null
  for (const file of files) {
    const path = facts.pathOf(file)
    const name = file.name || baseName(path)
    let made: MessageExtra | FileRefusal
    if (extras.length >= facts.room) made = 'count'
    else if (planFile(facts.local, path) === 'ref') made = { kind: 'file', name, path }
    else made = await inlineFile(file)
    if (typeof made === 'string') refused ??= { why: made, name }
    else extras.push(made)
  }
  return { extras, refused }
}
