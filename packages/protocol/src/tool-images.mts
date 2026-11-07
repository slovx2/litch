/** 工具结果图片：只给声明 toolImages 的连接；原图不放进条目。 */
export const TOOL_IMAGES_EXTENSION = 'toolImages'
export const TOOL_IMAGES_SETTING = 'privacy.toolImages'
export const TOOL_IMAGE_PREFIX = 'litch-tool-image:'
export const TOOL_IMAGE_LIMIT = 16
export interface ToolImage {
  id: string
  tool: string
  mime: string
  bytes: number
  width: number
  height: number
  thumbnail: { dataBase64: string; mime: 'image/png'; width: number; height: number } | null
}

/** 不相信远端的元数据；限制消息副本的体积与解码预算。 */
export function toolImagesOf(value: unknown): ToolImage[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, TOOL_IMAGE_LIMIT).filter((image): image is ToolImage => {
    if (!image || typeof image !== 'object') return false
    const thumb = image.thumbnail
    return (
      /^[a-f0-9]{64}$/.test(image.id) &&
      typeof image.tool === 'string' &&
      image.tool.length <= 256 &&
      ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mime) &&
      Number.isSafeInteger(image.bytes) &&
      image.bytes > 0 &&
      image.bytes <= 8 * 1024 * 1024 &&
      Number.isSafeInteger(image.width) &&
      Number.isSafeInteger(image.height) &&
      image.width > 0 &&
      image.height > 0 &&
      image.width <= 16384 &&
      image.height <= 16384 &&
      image.width * image.height <= 20_000_000 &&
      (thumb === null ||
        (thumb?.mime === 'image/png' &&
          Number.isSafeInteger(thumb.width) &&
          Number.isSafeInteger(thumb.height) &&
          thumb.width > 0 &&
          thumb.height > 0 &&
          thumb.width <= 160 &&
          thumb.height <= 160 &&
          typeof thumb.dataBase64 === 'string' &&
          thumb.dataBase64.length <= 96 * 1024 &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(thumb.dataBase64)))
    )
  })
}
