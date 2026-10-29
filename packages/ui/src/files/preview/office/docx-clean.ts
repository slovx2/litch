import DOMPurify from 'dompurify'
import JSZip from 'jszip'
import { imageInfo } from '../image-info.ts'
import { OfficeFailure, type Part } from './archive.ts'

export async function cleanDocx(parts: Part[]): Promise<ArrayBuffer> {
  const zip = new JSZip(),
    names = new Set(parts.map((p) => p.name))
  if (!names.has('word/document.xml') || !names.has('[Content_Types].xml'))
    throw new OfficeFailure('invalid')
  let pixels = 0,
    images = 0
  let elements = 0,
    pages = 0
  for (const part of parts) {
    if (/^word\/(fonts|embeddings)\//.test(part.name) || /\.(html?|mht|svg)$/i.test(part.name))
      continue
    if (!/\.(xml|rels)$/i.test(part.name)) {
      // 不按 media/ 目录猜图片：任意 relationship 目标都必须先经过格式/像素预算。
      if (!/\.(png|jpe?g|gif|webp)$/i.test(part.name)) continue
      const info = imageInfo(part.bytes)
      if (!info || ++images > 16 || (pixels += info.width * info.height) > 40_000_000)
        throw new OfficeFailure('budget')
    }
    if (/\.(xml|rels)$/i.test(part.name)) {
      const doc = new DOMParser().parseFromString(
        new TextDecoder().decode(part.bytes),
        'application/xml',
      )
      if (doc.querySelector('parsererror')) throw new OfficeFailure('invalid')
      for (const el of Array.from(doc.getElementsByTagName('*'))) {
        if (++elements > 100_000) throw new OfficeFailure('budget')
        if (
          (el.localName === 'sectPr' ||
            (el.localName === 'br' &&
              el.getAttributeNS(
                'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
                'type',
              ) === 'page')) &&
          ++pages > 200
        )
          throw new OfficeFailure('budget')
        if (
          ['altChunk', 'object', 'OLEObject', 'control', 'attachedTemplate'].includes(el.localName)
        ) {
          el.remove()
          continue
        }
        if (el.localName === 'Relationship') {
          const target = el.getAttribute('Target') ?? '',
            type = el.getAttribute('Type') ?? ''
          if (
            el.getAttribute('TargetMode') === 'External' ||
            /^(?:[a-z][\w+.-]*:|\/\/)/i.test(target) ||
            /[\\\x00-\x1f]/.test(target) ||
            /hyperlink|aFChunk|oleObject|control|font|attachedTemplate/i.test(type)
          )
            el.remove()
        }
      }
      zip.file(part.name, new XMLSerializer().serializeToString(doc))
    } else zip.file(part.name, part.bytes)
  }
  return zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })
}

function cleanStyle(style: CSSStyleDeclaration): void {
  for (const property of Array.from(style)) {
    const value = style.getPropertyValue(property)
    // CSSOM 先解析转义/注释；残余转义和任何资源/动画声明都不进入展示文档。
    if (
      /\\|url\s*\(|image-set|expression\s*\(/i.test(value) ||
      /animation|transition|filter/.test(property)
    ) {
      style.removeProperty(property)
      continue
    }
    for (const match of value.matchAll(
      /(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(px|pt|cm|mm|in|em|rem|vh|vw|%)\b/gi,
    )) {
      const unit = match[2]?.toLowerCase() ?? ''
      const factor =
        (
          {
            pt: 4 / 3,
            cm: 96 / 2.54,
            mm: 96 / 25.4,
            in: 96,
            em: 128,
            rem: 128,
            vh: 100,
            vw: 100,
            '%': 1,
          } as Record<string, number>
        )[unit] ?? 1
      if (Math.abs(Number(match[1])) * factor > 16384) throw new OfficeFailure('budget')
    }
  }
}

// 在 detached 容器渲染后净化，再插入 iframe 文档。CSP 另行阻止 CSS 中的任何外链。
export function cleanRendered(host: HTMLElement): void {
  DOMPurify.sanitize(host, {
    IN_PLACE: true,
    ADD_TAGS: ['style'],
    FORBID_TAGS: [
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'video',
      'audio',
      'link',
      'meta',
      'base',
      'svg',
      'math',
    ],
    FORBID_ATTR: ['href', 'xlink:href', 'srcset', 'action', 'formaction', 'target'],
  })
  for (const el of host.querySelectorAll('*')) {
    if (
      el instanceof HTMLImageElement &&
      !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(el.src)
    )
      el.removeAttribute('src')
    if (el instanceof HTMLStyleElement) {
      const sheet = new CSSStyleSheet()
      // constructed sheet 不加载 @import；只保留普通样式规则，不接受字体或动画规则。
      sheet.replaceSync(el.textContent ?? '')
      const rules: string[] = []
      for (const rule of Array.from(sheet.cssRules))
        if (rule instanceof CSSStyleRule) {
          cleanStyle(rule.style)
          // CSSStyleRule 也可包含嵌套规则；只重建已清理的顶层声明，子规则全部丢弃。
          rules.push(`${rule.selectorText} { ${rule.style.cssText} }`)
        }
      el.textContent = rules.join('\n')
    }
    if (el instanceof HTMLElement) cleanStyle(el.style)
  }
}
