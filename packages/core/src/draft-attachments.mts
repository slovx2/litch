// 附件选取只读本地文件；两端在发送时才上传，失败后保留原草稿。
import type { CoreChannel } from './channel/client.mjs'
import type { MessageExtra } from './model.mjs'
import { base64Bytes } from './text/bytes.mjs'

type FileExtra = Extract<MessageExtra, { kind: 'file' }>

export function stageAttachment(name: string, dataBase64: string, mimeType?: string): FileExtra {
  return {
    kind: 'file',
    name,
    path: `draft:${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`,
    dataBase64,
    size: base64Bytes(dataBase64),
    ...(mimeType ? { mimeType } : {}),
  }
}

/** 不修改调用方草稿；上传失败时由原发送流程回填。图片仍随消息内联发送。 */
export async function uploadDraftAttachments(
  channel: CoreChannel,
  deviceId: string,
  extras: MessageExtra[],
): Promise<MessageExtra[]> {
  const ready: MessageExtra[] = []
  for (const extra of extras) {
    if (extra.kind !== 'file' || extra.dataBase64 === undefined) ready.push(extra)
    else
      ready.push(
        await channel.command('files.uploadAttachment', {
          deviceId,
          name: extra.name,
          dataBase64: extra.dataBase64,
          ...(extra.mimeType ? { mimeType: extra.mimeType } : {}),
        }),
      )
  }
  return ready
}
