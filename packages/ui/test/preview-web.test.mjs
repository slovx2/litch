import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCsv } from '../src/files/preview/web/csv.ts'
import { mediaType } from '../src/files/preview/web/media.ts'

const bytes = (text) => new TextEncoder().encode(text)
test('CSV/TSV：引号、换行、BOM、长数字和公式都保持字符串', () => {
  const table = parseCsv(
    bytes(
      '\ufeff名称,值\r\n"中文,逗号","两\n行"\r\n900719925474099312345,=cmd|calc\r\n"<img src=x onerror=alert(1)>",TRUE',
    ),
    false,
  )
  assert.deepEqual(table.rows[1], ['中文,逗号', '两\n行'])
  assert.deepEqual(table.rows[2], ['900719925474099312345', '=cmd|calc'])
  assert.equal(table.rows[3][1], 'TRUE')
  assert.deepEqual(parseCsv(bytes('a\tb\n"x\ty"\tz'), true).rows, [
    ['a', 'b'],
    ['x\ty', 'z'],
  ])
})
test('CSV：行列、原始字节预算，坏编码和坏引号', () => {
  const wide = Array.from({ length: 101 }, () => 'x').join(',')
  const table = parseCsv(bytes(`${wide}\n`.repeat(10001)), false)
  assert.equal(table.rows.length, 10000)
  assert.equal(table.columns, 100)
  assert.equal(table.rowLimit, true)
  assert.equal(table.columnLimit, true)
  assert.throws(() => parseCsv(new Uint8Array(2 * 1024 * 1024 + 1), false))
  assert.throws(() => parseCsv(new Uint8Array([0xff]), false))
  assert.ok(parseCsv(bytes('a,b\n"unclosed'), false).errors > 0)
})
test('媒体：扩展名不能绕过容器头检查', () => {
  assert.equal(mediaType('x.mp4', bytes('<script>bad</script>')), null)
  const wav = new Uint8Array(44)
  wav.set(bytes('RIFF'))
  wav.set(bytes('WAVE'), 8)
  assert.deepEqual(mediaType('x.wav', wav), { kind: 'audio', mime: 'audio/wav' })
  assert.equal(mediaType('x.mp3', wav), null)
  assert.equal(mediaType('x.webm', new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])), null)
})
