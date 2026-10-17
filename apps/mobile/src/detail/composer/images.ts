// 往消息里加图片：从系统的相册选，读成 data URL。图片内联在消息里发给设备（和桌面端同一条路，不往设备上传文件），
// 所以照桌面端的规矩卡住类型、单张大小、张数（packages/ui/src/composer/images.ts），核心发之前还会再验一遍。
import { type ImageAttachment, MAX_IMAGES } from '@litch/core'
import { launchImageLibraryAsync } from 'expo-image-picker'
import type { Key } from '../../ui/i18n'

export { MAX_IMAGES }

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
/** 单张图片的上限 */
export const MAX_IMAGE_MB = 8
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024

/** 没加成的原因，对着桌面端现成的那几句话 */
export type ImageRefusal = 'type' | 'size' | 'count' | 'read'

export const REFUSAL_TEXT: Record<ImageRefusal, Key> = {
  type: 'composer.image.type',
  size: 'composer.image.size',
  count: 'composer.image.count',
  read: 'composer.image.read',
}

const EXTENSION_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function typeOf(mime: string | undefined, uri: string): string | null {
  if (mime) return mime.toLowerCase()
  const extension = uri.split('?')[0]?.split('.').pop()?.toLowerCase() ?? ''
  return EXTENSION_TYPE[extension] ?? null
}

/**
 * 打开系统的相册挑图。room 是还能加几张。用户没选（取消了）返回 null。
 * base64 的长度按 3/4 折成字节数：fileSize 不是每台机器都给
 */
export async function pickImages(
  room: number,
): Promise<{ images: ImageAttachment[]; refused: ImageRefusal | null } | null> {
  if (room <= 0) return { images: [], refused: 'count' }
  let result: Awaited<ReturnType<typeof launchImageLibraryAsync>>
  try {
    result = await launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: room,
      base64: true,
    })
  } catch {
    return { images: [], refused: 'read' }
  }
  if (result.canceled) return null
  const images: ImageAttachment[] = []
  let refused: ImageRefusal | null = null
  for (const asset of result.assets) {
    const type = typeOf(asset.mimeType, asset.uri)
    const bytes = asset.base64 ? Math.floor((asset.base64.length * 3) / 4) : 0
    let why: ImageRefusal | null = null
    if (!type || !IMAGE_TYPES.includes(type)) why = 'type'
    else if (!asset.base64) why = 'read'
    else if (bytes > MAX_IMAGE_BYTES || (asset.fileSize ?? 0) > MAX_IMAGE_BYTES) why = 'size'
    else if (images.length >= room) why = 'count'
    else images.push({ url: `data:${type};base64,${asset.base64}`, name: asset.fileName ?? null })
    refused ??= why
  }
  return { images, refused }
}
