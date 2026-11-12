import {
  type ImageAttachment,
  MAX_ATTACHMENT_BYTES,
  type MessageExtra,
  stageAttachment,
} from '@litch/core'
import { getDocumentAsync } from 'expo-document-picker'
import { File } from 'expo-file-system'

export type FileExtra = Extract<MessageExtra, { kind: 'file' }>

/** 手机沙箱路径不交给模型；先读到草稿，发送时再上传。 */
export async function pickFile(): Promise<
  FileExtra | (ImageAttachment & { kind: 'image' }) | null
> {
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
    return stageAttachment(asset.name, data, asset.mimeType)
  } finally {
    // copyToCacheDirectory 创建的临时副本，不删除用户原文件。
    try {
      file.delete()
    } catch {
      /* 系统缓存也会回收 */
    }
  }
}
