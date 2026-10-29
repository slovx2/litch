import ExcelJS from 'exceljs/dist/exceljs.min.js'
import JSZip from 'jszip'
import { OfficeFailure, type Part } from './archive.ts'
import type { SheetData, WorkbookData } from './model.ts'
import { checkSheetReferences } from './sheet-references.ts'
import { scanXml, withoutXmlNodes } from './xml.ts'

const ROWS = 10_000,
  COLUMNS = 200,
  CELLS = 100_000,
  FROZEN_ROWS = 10,
  FROZEN_COLUMNS = 3
const MAX_ROW = 1_048_576,
  MAX_COLUMN = 16_384
interface SheetExtent {
  rows: number
  columns: number
}
const reject = (): never => {
  throw new OfficeFailure('budget')
}
export function address(value: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value)
  if (!match) throw new OfficeFailure('invalid')
  let column = 0
  for (const c of match[1] ?? '') column = column * 26 + c.charCodeAt(0) - 64
  const row = Number(match[2])
  if (row > MAX_ROW || column > MAX_COLUMN) throw new OfficeFailure('invalid')
  return { row, column }
}
// ExcelJS 会展开合并范围；加载前限制真实节点、坐标和合并面积，不能在加载后才数。
export function checkSheets(parts: Part[]): Map<string, SheetExtent> {
  const extents = new Map<string, SheetExtent>()
  let cells = 0,
    strings = 0,
    merges = 0,
    mergeCount = 0,
    sheets = 0
  for (const part of parts) {
    if (!part.name.endsWith('.xml')) continue
    const xml = new TextDecoder().decode(part.bytes)
    if (part.name === 'xl/workbook.xml') {
      const ids = new Set<number>()
      scanXml(xml, (tag) => {
        if (tag.local !== 'sheet') return
        const id = Number(tag.attributes.sheetId?.value)
        if (!Number.isInteger(id) || id < 1 || id > 1000 || ids.has(id) || ids.size >= 100) reject()
        ids.add(id)
      })
    }
    if (part.name === 'xl/sharedStrings.xml') {
      scanXml(xml, (tag) => {
        if (tag.local === 'si' && ++strings > CELLS) reject()
      })
    }
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(part.name)) continue
    if (++sheets > 100) reject()
    const extent = { rows: 0, columns: 0 }
    extents.set(part.name, extent)
    scanXml(xml, (tag) => {
      const kind = tag.local
      if (!['c', 'row', 'mergeCell'].includes(kind)) return
      if (tag.prefix) throw new OfficeFailure('invalid')
      if (kind === 'c' && ++cells > CELLS) reject()
      const ref = tag.attributes[kind === 'mergeCell' ? 'ref' : 'r']?.value
      if (!ref) throw new OfficeFailure('invalid')
      if (kind === 'row') {
        if (!/^[1-9]\d*$/.test(ref) || Number(ref) > MAX_ROW) throw new OfficeFailure('invalid')
        extent.rows = Math.max(extent.rows, Number(ref))
        return
      }
      const [first = '', last] = ref.split(':')
      const a = address(first),
        b = address(last ?? first)
      extent.rows = Math.max(extent.rows, a.row, b.row)
      extent.columns = Math.max(extent.columns, a.column, b.column)
      if (kind === 'mergeCell') {
        if (++mergeCount > 1000) reject()
        if (b.row < a.row || b.column < a.column) throw new OfficeFailure('invalid')
        merges += (b.row - a.row + 1) * (b.column - a.column + 1)
        if (merges > CELLS) reject()
      }
    })
  }
  if (cells + merges > CELLS) reject()
  return extents
}

function columnLabel(value: number): string {
  let text = ''
  for (let n = value; n > 0; n = Math.floor((n - 1) / 26))
    text = String.fromCharCode(65 + ((n - 1) % 26)) + text
  return text
}
/** 先核整本安全预算，再截取显示窗口；远端稀疏坐标不能让库分配巨型行数组。 */
function clipWorksheet(xml: string, omitted: ReadonlySet<string>): string {
  return withoutXmlNodes(xml, omitted, (tag) => {
    if (tag.local === 'row') return Number(tag.attributes.r?.value) <= ROWS
    if (tag.local === 'c') {
      const cell = address(tag.attributes.r?.value ?? '')
      return cell.row <= ROWS && cell.column <= COLUMNS
    }
    if (tag.local === 'mergeCell') {
      const ref = tag.attributes.ref
      const [first = '', last] = (ref?.value ?? '').split(':')
      const start = address(first),
        end = address(last ?? first)
      if (start.row > ROWS || start.column > COLUMNS) return false
      if (ref)
        ref.value = `${first}:${columnLabel(Math.min(end.column, COLUMNS))}${Math.min(end.row, ROWS)}`
    }
    return true
  })
}
function valueText(value: ExcelJS.CellValue): string {
  if (value == null) return ''
  if (value instanceof Date)
    return Number.isNaN(value.getTime())
      ? ''
      : value
          .toISOString()
          .replace(/T00:00:00\.000Z$/, '')
          .replace('.000Z', 'Z')
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value !== 'object') return String(value)
  if ('formula' in value || 'sharedFormula' in value) {
    if (value.result !== undefined) return valueText(value.result)
    return 'formula' in value ? `=${value.formula}` : `=${value.sharedFormula}`
  }
  if ('richText' in value) return value.richText.map((run) => run.text).join('')
  if ('text' in value) return value.text
  if ('error' in value) return value.error
  return ''
}
/** 数字和日期（含公式保存的结果）按 Excel 的习惯靠右显示 */
function displayValue(cell: ExcelJS.Cell): ExcelJS.CellValue {
  const raw = cell.value
  // value 的公式副本会丢掉 false/0；直接读取结果访问器，保留文件中已保存的假值。
  if (raw && typeof raw === 'object' && ('formula' in raw || 'sharedFormula' in raw)) {
    const result = cell.result
    if (result !== undefined) return result
  }
  return raw
}
function isNumeric(cell: ExcelJS.Cell): boolean {
  const value = displayValue(cell)
  return (typeof value === 'number' && Number.isFinite(value)) || value instanceof Date
}
/** 常见十进制/千分位/百分比格式；复杂自定义格式保留值，不猜测货币或地区日期。 */
function cellText(cell: ExcelJS.Cell): string {
  const value = displayValue(cell)
  if (typeof value !== 'number' || !Number.isFinite(value)) return valueText(value)
  const format = cell.numFmt?.split(';')[0] ?? ''
  if (!/^[#0,]+(?:\.[0#]+)?%?$/.test(format)) return String(value)
  const fraction = format.split('.')[1]?.replace('%', '') ?? ''
  return new Intl.NumberFormat('en-US', {
    style: format.endsWith('%') ? 'percent' : 'decimal',
    useGrouping: format.includes(','),
    minimumFractionDigits: Math.min(15, fraction.replaceAll('#', '').length),
    maximumFractionDigits: Math.min(15, fraction.length),
  }).format(value)
}
export async function spreadsheet(parts: Part[]): Promise<WorkbookData> {
  const targets = checkSheetReferences(parts)
  const extents = checkSheets(parts)
  const referenced = new Set(targets.values())
  const zip = new JSZip()
  const omitted = new Set([
    'definedNames',
    'cols',
    'dataValidations',
    'conditionalFormatting',
    'hyperlinks',
    'extLst',
    'drawing',
    'picture',
    'tableParts',
    'sheetProtection',
    'rowBreaks',
    'colBreaks',
    'pageSetup',
    'pageMargins',
    'headerFooter',
    'autoFilter',
    'dimension',
  ])
  // 只给库数据预览需要的部件，避免 Node/打印/图片及其他格式功能扩大解析面。
  for (const part of parts) {
    if (
      !/^(?:\[Content_Types\]\.xml|_rels\/\.rels|xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|styles\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml))$/.test(
        part.name,
      )
    )
      continue
    if (part.name.startsWith('xl/worksheets/')) {
      if (referenced.has(part.name))
        zip.file(part.name, clipWorksheet(new TextDecoder().decode(part.bytes), omitted))
    } else if (part.name === 'xl/workbook.xml')
      zip.file(part.name, withoutXmlNodes(new TextDecoder().decode(part.bytes), omitted))
    else zip.file(part.name, part.bytes)
  }
  const bytes = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes, {
    ignoreNodes: [...omitted],
  })
  const sheets: SheetData[] = []
  let count = 0,
    textBytes = 0
  for (const sheet of book.worksheets) {
    const path = targets.get(sheet.id),
      extent = path ? extents.get(path) : undefined
    if (!extent) throw new OfficeFailure('invalid')
    const cells: Record<string, string> = Object.create(null)
    const numeric: Record<string, true> = Object.create(null)
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (++count > CELLS) reject()
        if (!cell.isMerged || cell.master.address === cell.address) {
          const value = cellText(cell)
          if (value.length > 100_000) reject()
          textBytes += value.length * 2
          // sharedStrings 可由大量单元格重复引用；返回前按展开后的文本累计计费。
          if (textBytes > 8 * 1024 * 1024) reject()
          cells[`${row.number}:${cell.col}`] = value
          if (isNumeric(cell)) numeric[`${row.number}:${cell.col}`] = true
        }
      }),
    )
    const merges = (sheet.model.merges ?? []).map((ref) => {
      const [a = '', b] = ref.split(':')
      const start = address(a),
        end = address(b ?? a)
      return { top: start.row, left: start.column, bottom: end.row, right: end.column }
    })
    // 侧面板很窄：冻结得太多会把可滚动的部分挤没，超出的部分照常滚动
    const view = sheet.views?.[0]
    const frozen =
      view?.state === 'frozen'
        ? {
            rows: Math.min(FROZEN_ROWS, Math.max(0, Math.floor(view.ySplit ?? 0))),
            columns: Math.min(FROZEN_COLUMNS, Math.max(0, Math.floor(view.xSplit ?? 0))),
          }
        : { rows: 0, columns: 0 }
    sheets.push({
      name: sheet.name,
      rows: Math.min(extent.rows, ROWS),
      columns: Math.min(extent.columns, COLUMNS),
      truncated: extent.rows > ROWS || extent.columns > COLUMNS,
      cells,
      numeric,
      frozen,
      merges,
    })
  }
  return { sheets }
}
