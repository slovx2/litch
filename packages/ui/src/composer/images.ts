// 往消息里加图片：从剪贴板、拖放或文件选择器拿到文件，读成 data URL。
// 图片直接内联在消息里发给设备，所以要卡住类型、单张大小和张数。
import { type ImageAttachment, MAX_IMAGES } from '@litch/core'

/** 各个引擎都收的图片类型 */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
/** 单张图片的上限 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** 没加成的原因：类型不对、太大、张数满了、读不出来 */
export type ImageRefusal = 'type' | 'size' | 'count' | 'read'

export interface ReadResult {
  images: ImageAttachment[]
  /** 有文件没加成时，第一个没加成的原因 */
  refused: ImageRefusal | null
}

/** 剪贴板或拖放的内容里有没有文件 */
export const hasFiles = (data: DataTransfer | null): boolean =>
  data !== null && Array.from(data.types).includes('Files')

const readAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

/**
 * 把文件读成图片附件。room 是还能加几张；named 为假时不留文件名
 * （剪贴板里的图名字都是 image.png，没有意义）。
 */
export async function readImages(files: File[], room: number, named: boolean): Promise<ReadResult> {
  const images: ImageAttachment[] = []
  let refused: ImageRefusal | null = null
  for (const file of files) {
    let why: ImageRefusal | null = null
    if (!IMAGE_TYPES.includes(file.type)) why = 'type'
    else if (file.size > MAX_IMAGE_BYTES) why = 'size'
    else if (images.length >= room) why = 'count'
    else {
      try {
        images.push({ url: await readAsDataUrl(file), name: named ? file.name || null : null })
      } catch {
        why = 'read'
      }
    }
    refused ??= why
  }
  return { images, refused }
}

export { MAX_IMAGES }
