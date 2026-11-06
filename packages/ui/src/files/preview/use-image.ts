import type { FilePreview } from '@litch/core'
import { useEffect, useState } from 'react'
import type { MessageKey } from '../../i18n/index.ts'
import { checkedImage } from './image-resource.ts'
import type { PreviewResources } from './resources.ts'

export function usePreviewImage(
  content: FilePreview | null,
  resources: PreviewResources | null,
  key: string,
) {
  const [image, setImage] = useState<{ url: string; width: number; height: number } | null>(null)
  const [failure, setFailure] = useState<MessageKey | null>(null)
  useEffect(() => {
    setImage(null)
    setFailure(null)
    if (content?.kind !== 'ready' || !resources) return
    const parsed = checkedImage(content)
    if (!parsed) {
      setFailure('preview.imageInvalid')
      return
    }
    if (!resources.claimPixels(key, parsed.info.width * parsed.info.height)) {
      setFailure('preview.imageBudget')
      return
    }
    const lease = resources.imageLease(
      key,
      () => ({
        url: URL.createObjectURL(
          new Blob([new Uint8Array(parsed.bytes)], { type: parsed.info.mime }),
        ),
        width: parsed.info.width,
        height: parsed.info.height,
      }),
      (url) => URL.revokeObjectURL(url),
    )
    // 浏览器会按 JPEG EXIF 旋转；灯箱缩放和复制必须采用实际解码尺寸。
    let live = true
    const probe = new Image()
    probe.onload = () => {
      if (!live) return
      const width = probe.naturalWidth,
        height = probe.naturalHeight
      const w = Math.ceil(parsed.info.width),
        h = Math.ceil(parsed.info.height)
      if (
        !width ||
        !height ||
        width * height > 20_000_000 ||
        !((width <= w && height <= h) || (width <= h && height <= w))
      ) {
        setFailure('preview.imageInvalid')
        return
      }
      setImage({ ...lease.image, width, height })
    }
    probe.onerror = () => {
      if (live) setFailure('preview.imageInvalid')
    }
    probe.src = lease.image.url
    return () => {
      live = false
      probe.onload = null
      probe.onerror = null
      probe.removeAttribute('src')
      lease.release()
    }
  }, [content, resources, key])
  return { image, failure, fail: () => setFailure('preview.imageInvalid') }
}
