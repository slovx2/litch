export interface SheetData {
  name: string
  rows: number
  columns: number
  cells: Record<string, string>
  /** 数字与日期单元格（按“行:列”），和 Excel 一样靠右 */
  numeric: Record<string, true>
  /** 文件里冻结的行数、列数（已收在上限内） */
  frozen: { rows: number; columns: number }
  merges: { top: number; left: number; bottom: number; right: number }[]
}
export interface WorkbookData {
  sheets: SheetData[]
}
