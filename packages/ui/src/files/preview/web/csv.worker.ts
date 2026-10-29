import { parseCsv } from './csv.ts'

self.onmessage = (event: MessageEvent<{ buffer: ArrayBuffer; tsv: boolean }>) => {
  try {
    self.postMessage({ table: parseCsv(new Uint8Array(event.data.buffer), event.data.tsv) })
  } catch {
    self.postMessage({ error: true })
  }
}
