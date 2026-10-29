import Papa from 'papaparse'

export const CSV_ROWS = 10_000
export const CSV_COLUMNS = 100
export const CSV_BYTES = 2 * 1024 * 1024
export interface CsvTable {
  rows: string[][]
  columns: number
  rowLimit: boolean
  columnLimit: boolean
  errors: number
}

/** 仅解析内存文本，不使用 download；所有内容都是字符串，不计算公式。 */
export function parseCsv(bytes: Uint8Array, tsv: boolean): CsvTable {
  if (bytes.byteLength > CSV_BYTES) throw new Error('tooLarge')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const table: CsvTable = { rows: [], columns: 0, rowLimit: false, columnLimit: false, errors: 0 }
  Papa.parse<string[]>(text, {
    delimiter: tsv ? '\t' : '',
    dynamicTyping: false,
    header: false,
    skipEmptyLines: true,
    step(result, parser) {
      if (table.rows.length === CSV_ROWS) {
        table.rowLimit = true
        parser.abort()
        return
      }
      table.errors += result.errors.length
      table.columnLimit ||= result.data.length > CSV_COLUMNS
      const row = result.data.slice(0, CSV_COLUMNS)
      table.columns = Math.max(table.columns, row.length)
      table.rows.push(row)
    },
  })
  return table
}
