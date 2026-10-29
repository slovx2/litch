import ExcelJS from 'exceljs/dist/exceljs.min.js'
import JSZip from 'jszip'
import { OfficeFailure, type Part } from './archive.ts'
import type { SheetData, WorkbookData } from './model.ts'
import { scanXml } from './xml.ts'

const ROWS = 10_000,
  COLUMNS = 200,
  CELLS = 100_000
const reject = (): never => {
  throw new OfficeFailure('budget')
}
export function address(value: string): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(value)
  if (!match) throw new OfficeFailure('invalid')
  let column = 0
  for (const c of match[1] ?? '') column = column * 26 + c.charCodeAt(0) - 64
  const row = Number(match[2])
  if (row > ROWS || column > COLUMNS) reject()
  return { row, column }
}
// ExcelJS 会展开合并范围；加载前限制真实节点、坐标和合并面积，不能在加载后才数。
export function checkSheets(parts: Part[]): void {
  let cells = 0,
    strings = 0,
    merges = 0,
    mergeCount = 0,
    sheets = 0
  for (const part of parts) {
    if (!part.name.endsWith('.xml')) continue
    const xml = new TextDecoder().decode(part.bytes)
    if (part.name === 'xl/sharedStrings.xml') {
      scanXml(xml, (tag) => {
        if (tag.local === 'si' && ++strings > CELLS) reject()
      })
    }
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(part.name)) continue
    if (++sheets > 100) reject()
    scanXml(xml, (tag) => {
      const kind = tag.local
      if (!['c', 'row', 'mergeCell'].includes(kind)) return
      if (tag.prefix) throw new OfficeFailure('invalid')
      if (kind === 'c' && ++cells > CELLS) reject()
      const ref = tag.attributes[kind === 'mergeCell' ? 'ref' : 'r']?.value
      if (!ref) throw new OfficeFailure('invalid')
      if (kind === 'row') {
        if (!/^[1-9]\d*$/.test(ref) || Number(ref) > ROWS) reject()
        return
      }
      const [first = '', last] = ref.split(':')
      const a = address(first),
        b = address(last ?? first)
      if (kind === 'mergeCell') {
        if (++mergeCount > 1000) reject()
        if (b.row < a.row || b.column < a.column) throw new OfficeFailure('invalid')
        merges += (b.row - a.row + 1) * (b.column - a.column + 1)
        if (merges > CELLS) reject()
      }
    })
  }
  if (cells + merges > CELLS) reject()
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
/** 常见十进制/千分位/百分比格式；复杂自定义格式保留值，不猜测货币或地区日期。 */
function cellText(cell: ExcelJS.Cell): string {
  const raw = cell.value
  const value = raw && typeof raw === 'object' && 'result' in raw ? raw.result : raw
  if (typeof value !== 'number' || !Number.isFinite(value)) return valueText(raw)
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
  checkSheets(parts)
  const zip = new JSZip()
  // 不向 ExcelJS 提供图片、外链、嵌入对象或绘图。数据单元格里的链接仅取显示文字。
  for (const part of parts) {
    if (/^xl\/(media|drawings|externalLinks|embeddings)\//.test(part.name)) continue
    zip.file(part.name, part.bytes)
  }
  const bytes = await zip.generateAsync({ type: 'arraybuffer', compression: 'STORE' })
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes, {
    ignoreNodes: ['drawing', 'picture', 'extLst', 'conditionalFormatting'],
  })
  const sheets: SheetData[] = []
  let count = 0
  for (const sheet of book.worksheets) {
    if (sheet.rowCount > ROWS || sheet.columnCount > COLUMNS) reject()
    const cells: Record<string, string> = Object.create(null)
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (++count > CELLS) reject()
        if (!cell.isMerged || cell.master.address === cell.address) {
          const value = cellText(cell)
          if (value.length > 100_000) reject()
          cells[`${row.number}:${cell.col}`] = value
        }
      }),
    )
    const merges = (sheet.model.merges ?? []).map((ref) => {
      const [a = '', b] = ref.split(':')
      const start = address(a),
        end = address(b ?? a)
      return { top: start.row, left: start.column, bottom: end.row, right: end.column }
    })
    sheets.push({
      name: sheet.name,
      rows: sheet.rowCount,
      columns: sheet.columnCount,
      cells,
      merges,
    })
  }
  return { sheets }
}
