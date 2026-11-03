// 选文件、拖放和粘贴共用三种去向：设备路径、控制端路径、通过 fs 协议上传。
import type { MessageExtra } from '@litch/core'
import { MAX_ATTACHMENT_BYTES } from '../../../protocol/src/file-attachments.mts'

/**
 * 没带成的原因：
 * folder：无法访问的文件夹；size：超出上传上限；read：取不到路径；count：附件已满；upload：上传失败。
 */
export type FileRefusal = 'folder' | 'size' | 'read' | 'count' | 'upload'

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
  upload(file: File): Promise<Extract<MessageExtra, { kind: 'file' }>>
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
 * upload：上传到会话设备；refuse：无法访问的文件夹。
 */
export function planFile(
  facts: Pick<FileFacts, 'local' | 'machine'>,
  path: string,
  folder: boolean,
): 'ref' | 'client' | 'upload' | 'refuse' {
  if (path !== '' && facts.local) return 'ref'
  if (path !== '' && facts.machine === 'on') return 'client'
  return folder ? 'refuse' : 'upload'
}

/** 路径的最后一段 */
export const baseName = (path: string): string =>
  path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || path

/** 把选中、拖进来、贴进来的文件（已经把图片挑出去了）变成随消息带的东西 */
export async function readFiles(files: File[], facts: FileFacts): Promise<FilesResult> {
  const extras: MessageExtra[] = []
  let refused: FilesResult['refused'] = null
  for (const file of files) {
    const path = facts.pathOf(file)
    const folder = facts.isFolder(file)
    const name = file.name || baseName(path)
    const plan = planFile(facts, path, folder)
    let made: Extract<MessageExtra, { kind: 'file' }> | FileRefusal
    if (extras.length >= facts.room) made = 'count'
    // 本机设备上给不出路径的文件夹（不在桌面外壳里）读不出来；远程设备上的是读不到
    else if (plan === 'refuse') made = facts.local ? 'read' : 'folder'
    else if (plan === 'upload') {
      if (file.size > MAX_ATTACHMENT_BYTES) made = 'size'
      else {
        try {
          made = await facts.upload(file)
        } catch {
          made = 'upload'
        }
      }
    } else if (plan === 'client') made = clientRef(name, path, folder)
    else
      made = folder
        ? { kind: 'file', name, path: folderPath(path), folder }
        : { kind: 'file', name, path }
    if (typeof made === 'string') refused ??= { why: made, name }
    else
      extras.push(
        folder ? made : { ...made, size: file.size, ...(file.type ? { mimeType: file.type } : {}) },
      )
  }
  return { extras, refused }
}

/** 文件夹的路径末尾补一个 /（和核心、协议包里的写法一样） */
const folderPath = (path: string): string => (/[\\/]$/.test(path) ? path : `${path}/`)

const clientRef = (
  name: string,
  path: string,
  folder: boolean,
): Extract<MessageExtra, { kind: 'file' }> =>
  folder
    ? { kind: 'file', name, path: folderPath(path), folder, client: true }
    : { kind: 'file', name, path, client: true }
