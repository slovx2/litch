import { useEffect, useState } from 'react'
import type { ImageAsset } from './actions.ts'

/** 附件与旧查看器只接内联图片；以实际解码尺寸供同一灯箱和复制逻辑使用。 */
export function useInlineImage(url: string) {
  const [loaded, setLoaded] = useState<ImageAsset | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    setLoaded(null)
    setFailed(false)
    const image = new Image()
    image.src = url
    void image.decode().then(
      () => {
        if (live) setLoaded({ url, width: image.naturalWidth, height: image.naturalHeight })
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [url])
  return { image: loaded?.url === url ? loaded : undefined, failed }
}
