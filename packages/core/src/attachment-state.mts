import {
  type AttachmentState,
  managedAttachmentPath,
} from '../../protocol/src/file-attachments.mjs'
import type { CoreChannel } from './channel/client.mjs'

/** 两端统一：仅询问上传附件，断线或服务未声明时不误标成已清理。 */
export async function attachmentState(
  channel: CoreChannel,
  deviceId: string | undefined,
  file: { path?: string | undefined; client?: boolean | undefined },
): Promise<AttachmentState> {
  if (!deviceId || file.client || !file.path || !managedAttachmentPath(file.path)) return 'unknown'
  try {
    return (await channel.command('files.attachmentStatus', { deviceId, path: file.path })).state
  } catch {
    return 'unknown'
  }
}
