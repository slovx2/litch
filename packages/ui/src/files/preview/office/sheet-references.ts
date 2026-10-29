import { OfficeFailure, type Part } from './archive.ts'
import { scanXml } from './xml.ts'

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML_REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
function invalid(): never {
  throw new OfficeFailure('invalid')
}
/** 一张表只允许引用一个独占的部件；不让库把重复关系建模或悄悄覆盖 sheet 身份。 */
export function checkSheetReferences(parts: Part[]): void {
  const workbook = parts.find((part) => part.name === 'xl/workbook.xml')
  const relations = parts.find((part) => part.name === 'xl/_rels/workbook.xml.rels')
  if (!workbook || !relations) invalid()
  const names = new Set(parts.map((part) => part.name))
  const rels = new Map<string, { target: string; type: string; external: boolean }>()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  scanXml(decoder.decode(relations.bytes), (tag) => {
    if (tag.local !== 'Relationship' || tag.uri !== XML_REL) return
    const id = tag.attributes.Id?.value
    if (!id || rels.has(id)) invalid()
    rels.set(id, {
      target: tag.attributes.Target?.value ?? '',
      type: tag.attributes.Type?.value ?? '',
      external: tag.attributes.TargetMode?.value === 'External',
    })
  })
  const seen = new Set<string>()
  scanXml(decoder.decode(workbook.bytes), (tag) => {
    if (tag.local !== 'sheet') return
    const id = Object.values(tag.attributes).find(
      (attr) => attr.local === 'id' && attr.uri === REL,
    )?.value
    const rel = id ? rels.get(id) : undefined
    if (!rel || rel.external || rel.type !== `${REL}/worksheet`) invalid()
    // OOXML Target 是包内URI；相对路径和绝对 /xl/ 路径归到同一个键。
    if (!rel.target || /[\\%?#\x00-\x20]/.test(rel.target)) invalid()
    const target = new URL(rel.target, 'https://office.invalid/xl/workbook.xml')
    if (target.origin !== 'https://office.invalid') invalid()
    const path = target.pathname.slice(1)
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(path) || !names.has(path) || seen.has(path)) invalid()
    seen.add(path)
  })
}
