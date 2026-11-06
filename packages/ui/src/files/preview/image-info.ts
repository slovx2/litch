import { type ImageInfo, imageDimensions } from '../../../../core/src/image-info.mts'

export { imageInfo } from '../../../../core/src/image-info.mts'

export function svgInfo(source: string): ImageInfo | null {
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(source)) return null
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml')
  const root = doc.documentElement
  if (
    root.localName !== 'svg' ||
    root.namespaceURI !== 'http://www.w3.org/2000/svg' ||
    doc.querySelector('parsererror')
  )
    return null
  const elements = doc.querySelectorAll('*')
  if (elements.length > 5000) return null
  for (const el of elements) {
    if (/^(script|foreignObject|animate.*|set|discard|image|filter|fe.*)$/i.test(el.localName))
      return null
    let depth = 0,
      parent: Element | null = el
    while ((parent = parent.parentElement)) if (++depth > 128) return null
    for (const attr of el.attributes) {
      if (/^on/i.test(attr.name) || (attr.localName === 'href' && !attr.value.startsWith('#')))
        return null
    }
  }
  // 图像上下文还会阻止脚本和外链；这里提前拒绝主动内容与外部资源声明。
  if (/@import|@font-face|animation\s*:|url\s*\(\s*['"]?\s*(?!#)[^\s'")]/i.test(source)) return null
  const box = (root.getAttribute('viewBox') ?? '').trim().split(/[ ,]+/).map(Number)
  const dimension = (name: string, fallback: number) => {
    const raw = root.getAttribute(name)
    if (raw === null || raw.endsWith('%')) return fallback
    return /^\d+(?:\.\d+)?(?:px)?$/.test(raw) ? parseFloat(raw) : NaN
  }
  return imageDimensions(
    'image/svg+xml',
    dimension('width', box[2] || 300),
    dimension('height', box[3] || 150),
  )
}
