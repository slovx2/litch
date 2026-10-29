/**
 * PDF.js destroy 等 Worker 的 Terminate 回执之后才清字体/滤镜。
 * 超时强制终止 Worker 时仍须释放它们；经公开 ownerDocument 接口记录这份文档自己的资源，
 * 不按全局 FontFaceSet 快照删除，以免影响其他文件或应用字体。
 */
export function pdfDom() {
  const faces = new Set<FontFace>()
  const nodes = new Set<Node>()
  const sheets = new Set<CSSStyleSheet>()
  let closed = false
  const fonts = new Proxy(document.fonts, {
    get(target, key) {
      if (key === 'add')
        return (face: FontFace) => {
          if (!closed) {
            faces.add(face)
            target.add(face)
          }
          return target
        }
      if (key === 'delete')
        return (face: FontFace) => {
          faces.delete(face)
          return target.delete(face)
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const body = new Proxy(document.body, {
    get(target, key) {
      if (key === 'append')
        return (...values: (Node | string)[]) => {
          if (closed) return
          for (const node of values) if (node instanceof Node) nodes.add(node)
          target.append(...values)
        }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const ownerDocument = new Proxy(document, {
    get(target, key) {
      if (key === 'fonts') return fonts
      if (key === 'body') return body
      // Chromium 使用 FontFace，此处也记录库的 stylesheet 路线，确保销毁独立于 Worker。
      if (key === 'adoptedStyleSheets')
        return new Proxy(target.adoptedStyleSheets, {
          get(array, property) {
            if (property === 'push')
              return (...added: CSSStyleSheet[]) => {
                if (closed) return array.length
                for (const sheet of added) sheets.add(sheet)
                return array.push(...added)
              }
            return Reflect.get(array, property, array)
          },
        })
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    ownerDocument,
    dispose() {
      closed = true
      for (const face of faces) document.fonts.delete(face)
      for (const node of nodes) node.parentNode?.removeChild(node)
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (sheet) => !sheets.has(sheet),
      )
      faces.clear()
      nodes.clear()
      sheets.clear()
    },
  }
}
