import { SaxesParser, type SaxesTagNS } from 'saxes'
import { OfficeFailure } from './archive.ts'
/** 不构造 DOM 的 XML 预检；实体声明不进入库，属性以解析值检查，不能用正则猜引号边界。 */
export function scanXml(xml: string, visit: (tag: SaxesTagNS) => void = () => {}): number {
  const parser = new SaxesParser({ xmlns: true })
  let nodes = 0,
    depth = 0
  parser.on('doctype', () => {
    throw new OfficeFailure('active')
  })
  parser.on('processinginstruction', () => {
    throw new OfficeFailure('active')
  })
  parser.on('opentag', (tag) => {
    if (++nodes > 250_000 || ++depth > 128) throw new OfficeFailure('budget')
    visit(tag)
  })
  parser.on('closetag', () => {
    depth--
  })
  parser.write(xml).close()
  return nodes
}

/** 删除不参与数据预览的子树；用 SAX 重新编码，不能让嵌套标签/属性实体绕过删除。 */
export function withoutXmlNodes(
  xml: string,
  omitted: ReadonlySet<string>,
  keep: (tag: SaxesTagNS) => boolean = () => true,
): string {
  const parser = new SaxesParser({ xmlns: true })
  const output: string[] = []
  const encode = (text: string) =>
    text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
  let hidden = 0
  parser.on('opentag', (tag) => {
    if (hidden || omitted.has(tag.local) || !keep(tag)) {
      hidden++
      return
    }
    output.push(
      `<${tag.name}${Object.values(tag.attributes)
        .map((attr) => ` ${attr.name}="${encode(attr.value)}"`)
        .join('')}>`,
    )
  })
  parser.on('closetag', (tag) => {
    if (hidden) {
      hidden--
      return
    }
    output.push(`</${tag.name}>`)
  })
  const text = (value: string) => {
    if (!hidden) output.push(encode(value))
  }
  parser.on('text', text)
  parser.on('cdata', text)
  parser.on('doctype', () => {
    throw new OfficeFailure('active')
  })
  parser.write(xml).close()
  return output.join('')
}
