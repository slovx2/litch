import {
  type CoreChannel,
  type ImageAttachment,
  MAX_ATTACHMENT_BYTES,
  type MessageExtra,
} from '@litch/core'
import { getDocumentAsync } from 'expo-document-picker'
import { File } from 'expo-file-system'

export type FileExtra = Extract<MessageExtra, { kind: 'file' }>

/** 手机沙箱的路径不能交给远程模型；选取的文件始终经设备协议上传。 */
export async function pickFile(
  channel: CoreChannel,
  deviceId: string,
): Promise<FileExtra | (ImageAttachment & { kind: 'image' }) | null> {
  const result = await getDocumentAsync({ copyToCacheDirectory: true, multiple: false })
  if (result.canceled) return null
  const asset = result.assets[0]
  if (!asset) return null
  const file = new File(asset.uri)
  try {
    const image = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
      asset.mimeType ?? '',
    )
    if ((asset.size ?? file.size) > (image ? 8 * 1024 * 1024 : MAX_ATTACHMENT_BYTES))
      throw new Error(image ? 'imageTooLarge' : 'fileTooLarge')
    const data = await file.base64()
    if (image)
      return { kind: 'image', name: asset.name, url: `data:${asset.mimeType};base64,${data}` }
    return await channel.command('files.uploadAttachment', {
      deviceId,
      name: asset.name,
      dataBase64: data,
      ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
    })
  } finally {
    // copyToCacheDirectory 创建的临时副本，不删除用户原文件。
    try {
      file.delete()
    } catch {
      /* 系统缓存也会回收 */
    }
  }
}
