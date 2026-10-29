export interface SheetData {
  name: string
  rows: number
  columns: number
  cells: Record<string, string>
  merges: { top: number; left: number; bottom: number; right: number }[]
}
export interface WorkbookData {
  sheets: SheetData[]
}
