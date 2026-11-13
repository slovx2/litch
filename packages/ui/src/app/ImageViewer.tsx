import { useEffect } from 'react'
import type { MediaSource } from '../transcript/media/actions.ts'
import { Lightbox } from '../transcript/media/Lightbox.tsx'
import { useInlineImage } from '../transcript/media/use-inline-image.ts'
import { showToast } from './toasts.tsx'

interface ImageViewerProps {
  url: string
  label: string
  source?: MediaSource
  onClose(): void
}

/** 草稿、用户消息与内联工具图片均复用同一灯箱，调用方继续负责关闭后的编辑焦点。 */
export function ImageViewer({
  url,
  label,
  source = { kind: 'attachment' },
  onClose,
}: ImageViewerProps) {
  const { image, failed } = useInlineImage(url)
  useEffect(() => {
    if (failed) {
      showToast({
        id: 'image-viewer',
        tone: 'err',
        lifeMs: 5000,
        text: (t) => t('preview.imageInvalid'),
      })
      onClose()
    }
  }, [failed, onClose])
  return image ? (
    <Lightbox
      selected={url}
      entries={[{ id: url, ...image, label, href: label, source }]}
      close={onClose}
    />
  ) : null
}
