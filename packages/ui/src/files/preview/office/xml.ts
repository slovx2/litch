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
