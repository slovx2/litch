// 上传不经过模型：复用标准 fs/*，成功后仅把设备路径交给发送流程。
import { MAX_ATTACHMENT_BYTES } from '../../../protocol/src/file-attachments.mjs'
import { type AbortSignalLike, ChannelError } from '../channel/protocol.mjs'
import type { MessageExtra } from '../model.mjs'
import { base64Bytes } from '../text/bytes.mjs'
import { utf8Length } from '../text/output-cap.mjs'
import { isAbsolutePath, joinPath } from '../text/paths.mjs'
import type { FilesHost } from './files.mjs'

export interface AttachmentUpload {
  name: string
  dataBase64: string
  mimeType?: string
}

export async function uploadAttachment(
  host: FilesHost,
  upload: AttachmentUpload,
  signal?: AbortSignalLike,
): Promise<Extract<MessageExtra, { kind: 'file' }>> {
  if (!host.online()) throw new ChannelError('offline', '设备未连接')
  const home = host.home()
  if (!home || !isAbsolutePath(home))
    throw new ChannelError('unsupported', '设备没有提供附件存储位置')
  const { name, dataBase64, mimeType } = upload
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 4096 ||
    typeof dataBase64 !== 'string' ||
    dataBase64.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 ||
    base64Bytes(dataBase64) > MAX_ATTACHMENT_BYTES ||
    dataBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)
  ) {
    throw new ChannelError('invalid', '文件无效或超过 16 MB')
  }
  // 每次选择独立目录，重名不覆盖。远端文件名保留扩展名并避开 Windows 禁用字符。
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '')
  const chars = Array.from(cleaned || 'attachment').slice(-80)
  while (utf8Length(chars.join('')) > 200) chars.shift()
  const diskName = `file-${chars.join('')}`
  const id = `${host.clock.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  const dir = joinPath(home, `.litch/attachments/${id}`)
  const path = joinPath(dir, diskName)
  const options = { timeoutMs: 120_000, ...(signal ? { signal } : {}) }
  try {
    await host.request('fs/createDirectory', { path: dir, recursive: true }, options)
    await host.request('fs/writeFile', { path, dataBase64 }, options)
  } catch (error) {
    // 只清理本次上传的目录；取消信号不继续传入清理请求。
    try {
      await host.request('fs/remove', { path: dir, recursive: true, force: true })
    } catch {
      /* 断线时留待用户清理 */
    }
    throw host.fail(error)
  }
  return {
    kind: 'file',
    name,
    path,
    size: base64Bytes(dataBase64),
    ...(typeof mimeType === 'string' && mimeType.length > 0 && mimeType.length <= 4096
      ? { mimeType }
      : {}),
  }
}
