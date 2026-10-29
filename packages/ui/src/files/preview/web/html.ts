import DOMPurify from 'dompurify'

const TAGS =
  'a abbr b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img kbd li main mark ol p pre s section small span strong sub summary sup table tbody td th thead time tr u ul style'.split(
    ' ',
  )
const ATTRS = 'id class style title lang dir alt src width height colspan rowspan scope'.split(' ')
const CSS_PROPERTIES = new Set(
  'color background-color display visibility box-sizing width min-width max-width height min-height max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-width border-style border-color border-radius border-collapse border-spacing font font-family font-size font-style font-weight font-variant line-height letter-spacing word-spacing text-align text-decoration text-transform text-indent white-space word-break overflow-wrap vertical-align list-style-type list-style-position overflow overflow-x overflow-y flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-content align-self justify-content gap row-gap column-gap grid-template-columns grid-template-rows grid-column grid-row float clear opacity'.split(
    ' ',
  ),
)

/** CSS 仅保留静态排版属性。拒绝转义、变量和任何资源函数，不支持外部样式或字体。 */
function declarations(style: CSSStyleDeclaration): string {
  const safe = document.createElement('span').style
  for (const name of Array.from(style)) {
    const value = style.getPropertyValue(name)
    if (
      !CSS_PROPERTIES.has(name) ||
      /[\\@]|url\s*\(|image|expression|var\s*\(|attr\s*\(/i.test(value)
    )
      continue
    safe.setProperty(name, value)
  }
  return safe.cssText
}

function stylesheet(text: string): string {
  if (text.length > 65_536) return ''
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(text)
  let count = 0
  const rules = (list: CSSRuleList): string =>
    Array.from(list)
      .flatMap((rule) => {
        if (++count > 1000) return []
        if (rule instanceof CSSStyleRule) {
          const css = declarations(rule.style)
          // 文档内选择器不影响宿主，但限制大小，避免昂贵的选择器匹配。
          return css && rule.selectorText.length <= 256 && !rule.selectorText.includes(':has(')
            ? [`${rule.selectorText}{${css}}`]
            : []
        }
        if (rule instanceof CSSMediaRule && rule.conditionText.length <= 256)
          return [`@media ${rule.conditionText}{${rules(rule.cssRules)}}`]
        return []
      })
      .join('\n')
  return rules(sheet.cssRules)
}

export interface StaticHtml {
  fragment: DocumentFragment
  images: { element: HTMLImageElement; href: string }[]
}

/** template 中解析是惰性的，净化前的图片、脚本和 CSS 不会装入活动文档。 */
export function sanitizeHtml(source: string): StaticHtml {
  let marks = 0
  for (const ch of source) if (ch === '<' && ++marks > 20_000) throw new Error('domLimit')
  const template = document.createElement('template')
  template.innerHTML = source
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ALL)
  let nodes = 0
  while (walker.nextNode()) {
    if (++nodes > 10_000) throw new Error('domLimit')
    let depth = 0
    for (let parent = walker.currentNode.parentNode; parent; parent = parent.parentNode)
      if (++depth > 64) throw new Error('domLimit')
  }
  const fragment = DOMPurify.sanitize(template.content, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRS,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_CONTENTS: ['script', 'iframe', 'object', 'embed', 'template', 'svg', 'math', 'form'],
  })
  const images: StaticHtml['images'] = []
  for (const element of fragment.querySelectorAll('*')) {
    if (element instanceof HTMLStyleElement)
      element.textContent = stylesheet(element.textContent ?? '').replaceAll('<', '\\3c ')
    const inline = element.getAttribute('style')
    if (inline) {
      const style = document.createElement('span').style
      style.cssText = inline
      element.setAttribute('style', declarations(style))
    }
    if (element instanceof HTMLImageElement) {
      const href = element.getAttribute('src') ?? ''
      element.removeAttribute('src')
      if (href) images.push({ element, href })
    }
  }
  return { fragment, images }
}

export function htmlDocument(fragment: DocumentFragment): string {
  const wrapper = document.createElement('div')
  wrapper.append(fragment)
  // 文档自己的 CSP 比宿主更严；空 sandbox 禁脚本、同源、表单、弹窗和顶层导航。
  const csp =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light}body{margin:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${wrapper.innerHTML}</body></html>`
}
