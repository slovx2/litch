import type { Entry } from './types.ts'
import type { zhPreviewCsv } from './zh-CN-preview-csv.ts'
export const enPreviewCsv: Record<keyof typeof zhPreviewCsv, Entry> = {
  'preview.csv.table': 'Data table',
  'preview.csv.size': ({ rows, columns }) =>
    `${rows} ${Number(rows) === 1 ? 'row' : 'rows'} · ${columns} ${Number(columns) === 1 ? 'column' : 'columns'}`,
  'preview.csv.limit': 'Showing up to 10,000 rows and 100 columns.',
  'preview.csv.errors': 'Some rows are malformed. Showing the parsed values.',
  'preview.csv.invalid':
    'Could not parse this table. Check its UTF-8 encoding and content, or view the source.',
}
