import { useState } from 'react'
import { csv } from './external-source-form.ts'

/** 输入尾逗号时保留正在输入的字，提交时仍使用已去空、去重的数组。 */
export function CsvField({
  id,
  values,
  update,
}: {
  id: string
  values: string[]
  update(values: string[]): void
}) {
  const [raw, setRaw] = useState<string | null>(null)
  return (
    <input
      id={id}
      value={raw ?? values.join(', ')}
      onBlur={() => setRaw(null)}
      onChange={(event) => {
        setRaw(event.target.value)
        update(csv(event.target.value))
      }}
    />
  )
}
