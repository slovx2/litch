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
    const info = bytes.length <= IMAGE_BYTES ? imageInfo(bytes) : null
    if (!info) {
      clearTimeout(timer)
      fail()
      return
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: info.mime }))
    const image = document.createElement('img')
    image.id = 'stage'
    image.alt = config.name
    let release = () => {}
    image.onload = () => {
      clearTimeout(timer)
      if (image.naturalWidth !== info.width || image.naturalHeight !== info.height) {
        fail()
        return
      }
      image.width = info.width
      image.height = info.height
      release = previewGestures(image, info.width, info.height)
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
  } catch {
    clearTimeout(timer)
    fail()
  }
})()
