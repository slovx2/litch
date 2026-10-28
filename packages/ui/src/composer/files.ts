// 往消息里加不是图片的文件、文件夹。协议的输入里没有“文件附件”，带得过去的办法只有三种：
// - 按路径提到它（发出去是 mention，或者路径写进正文）：harness 得读得到这个路径，
//   所以只有消息是发给本机设备、外壳又给得出它在磁盘上的位置时才行；文件夹的路径末尾带 /，不展开里面的东西；
// - 消息发给远程设备、那台设备又打开了“操作这台电脑”（litch_machine）：按路径提到，标明路径在这台电脑上，
//   模型用 litch_machine 去读（client，见 protocol/src/client-paths.mts）；
// - 把内容读出来当一段文字带上：只有文本文件行，本机远程都一样（远程设备上的文本文件总是这样带）。
// 都不行的（远程设备没开“操作这台电脑”时的二进制文件、文件夹）当场说明，不做一个发出去对面读不到的东西；
// 也不替用户往设备上传文件。Codex、Claude 桌面端在远程会话里都不收本机文件夹。
// 纯逻辑：test/files.test.mjs 直接引这个文件，所以只用可擦除的语法、不引样式和组件。
import type { MessageExtra } from '@litch/core'
import { TEXT_LIMIT, tidyText } from './extras.ts'

/**
 * 没带成的原因：
 * binary 不是文本，内容带不了（这时也没法按路径提到它）；folder 是远程设备读不到的文件夹；size 内容太长；empty 是空的；
 * read 读不出来；count 这条消息带的东西已经满了
 */
export type FileRefusal = 'binary' | 'folder' | 'size' | 'empty' | 'read' | 'count'

/**
 * 远程设备能不能操作这台电脑（litch_machine）：on 打开了；off 关着（设备设置里能打开）；
 * null 这台桌面端给不了（本机设备也是 null）
 */
export type MachineReach = 'on' | 'off' | null

export interface FileFacts {
  /** 消息是发给本机设备的：harness 和这个界面在同一台机器上，读得到同样的路径 */
  local: boolean
  /** 消息发给远程设备时，那台设备能不能操作这台电脑 */
  machine: MachineReach
  /** 文件在磁盘上的位置。拿不到（不在桌面外壳里、文件不是从磁盘来的）就是空的 */
  pathOf(file: File): string
  /** 是不是文件夹（拖进来、贴进来时认得出；选文件的对话框选不了文件夹） */
  isFolder(file: File): boolean
  /** 还能带几样 */
  room: number
}

export interface FilesResult {
  extras: MessageExtra[]
  /** 有文件没带成时，第一个没带成的是哪个、为什么 */
  refused: { why: FileRefusal; name: string } | null
}

/** 拖进来、贴进来的东西里认出哪几个是文件夹。要在事件当场调（过后 items 就读不到了） */
export function filesOf(data: DataTransfer): { files: File[]; folders: Set<File> } {
  const files: File[] = []
  const folders = new Set<File>()
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (!file) continue
    files.push(file)
    if (item.webkitGetAsEntry?.()?.isDirectory) folders.add(file)
  }
  return files.length > 0 ? { files, folders } : { files: Array.from(data.files), folders }
}

/**
 * 一个文件或文件夹怎么带。ref：按路径提到它（会话所在的设备读得到）；client：按路径提到它，路径在这台电脑上；
 * inline：读出内容当文字带；refuse：带不了（远程设备读不到的文件夹）
 */
export function planFile(
  facts: Pick<FileFacts, 'local' | 'machine'>,
  path: string,
  folder: boolean,
): 'ref' | 'client' | 'inline' | 'refuse' {
  if (path !== '' && facts.local) return 'ref'
  if (folder) return path !== '' && facts.machine === 'on' ? 'client' : 'refuse'
  return 'inline'
}

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
    const folder = facts.isFolder(file)
    const name = file.name || baseName(path)
    const plan = planFile(facts, path, folder)
    let made: MessageExtra | FileRefusal
    if (extras.length >= facts.room) made = 'count'
    // 本机设备上给不出路径的文件夹（不在桌面外壳里）读不出来；远程设备上的是读不到
    else if (plan === 'refuse') made = facts.local ? 'read' : 'folder'
    else if (plan === 'inline') {
      made = await inlineFile(file)
      // 远程设备上带不了内容的文件：开了“操作这台电脑”就按这台电脑上的路径提到
      if (made === 'binary' && path !== '' && facts.machine === 'on')
        made = clientRef(name, path, false)
    } else if (plan === 'client') made = clientRef(name, path, folder)
    else
      made = folder
        ? { kind: 'file', name, path: folderPath(path), folder }
        : { kind: 'file', name, path }
    if (typeof made === 'string') refused ??= { why: made, name }
    else extras.push(made)
  }
  return { extras, refused }
}

/** 文件夹的路径末尾补一个 /（和核心、协议包里的写法一样） */
const folderPath = (path: string): string => (/[\\/]$/.test(path) ? path : `${path}/`)

const clientRef = (name: string, path: string, folder: boolean): MessageExtra =>
  folder
    ? { kind: 'file', name, path: folderPath(path), folder, client: true }
    : { kind: 'file', name, path, client: true }
