// 往消息里加图片：从系统的相册选，读成 data URL。图片内联在消息里发给设备（和桌面端同一条路，不往设备上传文件），
// 所以照桌面端的规矩卡住类型、单张大小、张数（packages/ui/src/composer/images.ts），核心发之前还会再验一遍。
import { base64Bytes, decodeBase64, type ImageAttachment, MAX_IMAGES } from '@litch/core'
import { launchImageLibraryAsync } from 'expo-image-picker'
import type { Key } from '../../ui/i18n'

export { MAX_IMAGES }

/** 单张图片的上限 */
export const MAX_IMAGE_MB = 8
const MAX_IMAGE_BYTES = MAX_IMAGE_MB * 1024 * 1024

/** 没加成的原因，对着桌面端现成的那几句话 */
export type ImageRefusal = 'type' | 'size' | 'count' | 'read' | 'open'

export const REFUSAL_TEXT: Record<ImageRefusal, Key> = {
  type: 'composer.image.type',
  size: 'composer.image.size',
  count: 'composer.image.count',
  read: 'compose.image.read',
  open: 'compose.image.open',
}

const EXTENSION_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function typeOf(data: string): string | null {
  // Expo iOS 的 base64 是转码后的 JPEG，mimeType、uri、fileSize 仍可能属于原始 HEIC/PNG。
  // 只解格式头，避免为了识别类型再分配整张图片；Android 保留它实际返回的 PNG/GIF/WebP。
  const head = decodeBase64(data.slice(0, 16))
  const word = (start: number, end: number) => String.fromCharCode(...head.subarray(start, end))
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (word(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png'
  if (['GIF87a', 'GIF89a'].includes(word(0, 6))) return 'image/gif'
  if (word(0, 4) === 'RIFF' && word(8, 12) === 'WEBP') return 'image/webp'
  return null
}

function imageName(name: string | null | undefined, type: string): string | null {
  if (!name) return null
  const extension = name.split('.').pop()?.toLowerCase() ?? ''
  if (EXTENSION_TYPE[extension] === type) return name
  const suffix = type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length)
  return `${name.replace(/\.[^.]+$/, '')}.${suffix}`
}

/**
 * 打开系统的相册挑图。room 是还能加几张。用户没选（取消了）返回 null。
 * 只限制实际发送的字节，原文件大小不代表转码后的大小。
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
  } catch (error) {
    // 同一个原生 Promise 也会在选择结束后的读取/编码阶段拒绝，不能全说成相册打不开。
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    const reading =
      typeof code === 'string' && /^ERR_FAILED_TO_(READ|WRITE|CREATE|EXPORT|PICK)_/.test(code)
    return { images: [], refused: reading ? 'read' : 'open' }
  }
  if (result.canceled) return null
  const images: ImageAttachment[] = []
  let refused: ImageRefusal | null = null
  for (const asset of result.assets) {
    const type = asset.base64 ? typeOf(asset.base64) : null
    const bytes = asset.base64 ? base64Bytes(asset.base64) : 0
    let why: ImageRefusal | null = null
    if (!asset.base64) why = 'read'
    else if (!type) why = 'type'
    else if (bytes > MAX_IMAGE_BYTES) why = 'size'
    else if (images.length >= room) why = 'count'
    else
      images.push({
        url: `data:${type};base64,${asset.base64}`,
        name: imageName(asset.fileName, type),
      })
    refused ??= why
  }
  return { images, refused }
}
