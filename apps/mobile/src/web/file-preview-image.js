// imageInfo 是构建时引入的桌面纯函数；在 WebView 内核对后才交给图像解码器。
;(() => {
  const config = window.__litchPreview
  const post = (value) => window.ReactNativeWebView?.postMessage(JSON.stringify(value))
  const fail = () => post({ kind: 'failed', reason: 'imageInvalid' })
  const timer = setTimeout(() => post({ kind: 'failed', reason: 'timeout' }), 20000)
  try {
    document.body.style.background = config.background
    const bytes = Uint8Array.from(atob(config.data), (char) => char.charCodeAt(0))
    config.data = ''
    const info =
      config.format === 'svg'
        ? bytes.length <= 1024 * 1024
          ? svgInfo(new TextDecoder().decode(bytes))
          : null
        : bytes.length <= IMAGE_BYTES
          ? imageInfo(bytes)
          : null
    if (!info || (config.format === 'svg' && info.width * info.height > 4_000_000)) {
      clearTimeout(timer)
      fail()
      return
    }
    const decode = () => {
      const url = URL.createObjectURL(new Blob([bytes], { type: info.mime }))
      const image = document.createElement('img')
      image.id = 'stage'
      image.alt = config.name
      let release = () => {}
      image.onload = () => {
        clearTimeout(timer)
        if (
          config.format !== 'svg' &&
          !(
            (image.naturalWidth === info.width && image.naturalHeight === info.height) ||
            (image.naturalWidth === info.height && image.naturalHeight === info.width)
          )
        ) {
          fail()
          return
        }
        // JPEG EXIF 可能交换宽高，以实际解码尺寸建立视口，避免横图被压成长图。
        const width = config.format === 'svg' ? info.width : image.naturalWidth
        const height = config.format === 'svg' ? info.height : image.naturalHeight
        image.width = width
        image.height = height
        release = previewGestures(image, width, height, config.thumbnail)
        if (config.thumbnail) {
          const scale = Math.min(1, 512 / width, 360 / height)
          const canvas = document.createElement('canvas')
          canvas.width = Math.max(1, Math.round(width * scale))
          canvas.height = Math.max(1, Math.round(height * scale))
          const context = canvas.getContext('2d')
          if (!context) {
            fail()
            return
          }
          context.drawImage(image, 0, 0, canvas.width, canvas.height)
          post({ kind: 'thumbnail', uri: canvas.toDataURL('image/png') })
        }
        post({ kind: 'ready', page: 1, pages: 1 })
      }
      image.onerror = () => {
        clearTimeout(timer)
        fail()
      }
      image.src = url
      document.body.append(image)
      window.addEventListener(
        'pagehide',
        () => {
          clearTimeout(timer)
          release()
          URL.revokeObjectURL(url)
        },
        { once: true },
      )
    }
    if (config.checkBudget) {
      window.__litchImageAuthorize = (allowed) => {
        delete window.__litchImageAuthorize
        if (allowed) decode()
        else {
          clearTimeout(timer)
          fail()
        }
      }
      post({ kind: 'imageInfo', width: info.width, height: info.height })
    } else decode()
  } catch {
    clearTimeout(timer)
    fail()
  }
})()
