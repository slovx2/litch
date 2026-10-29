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
    // TSV 按 IANA 规范没有引号转义；以引号开头的普通字段不能吞掉后面的行。
    fastMode: tsv ? true : undefined,
    dynamicTyping: false,
    header: false,
    skipEmptyLines: true,
    step(result, parser) {
      if (table.rows.length === CSV_ROWS) {
        table.rowLimit = true
        parser.abort()
        return
      }
      // 单列数据没有可识别的分隔符，但仍是有效 CSV；真正的引号等错误照常报告。
      table.errors += result.errors.filter((error) => error.code !== 'UndetectableDelimiter').length
      table.columnLimit ||= result.data.length > CSV_COLUMNS
      const row = result.data.slice(0, CSV_COLUMNS)
      table.columns = Math.max(table.columns, row.length)
      table.rows.push(row)
    },
  })
  return table
}
