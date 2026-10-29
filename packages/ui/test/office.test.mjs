import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  directory,
  EXPANDED_LIMIT,
  unpack,
  ZIP_LIMIT,
} from '../src/files/preview/office/archive.ts'
import { checkSheets, spreadsheet } from '../src/files/preview/office/spreadsheet.ts'
import { docx, xlsx, zipOf } from './office-fixtures.mjs'

test('Office ZIP：目录、实际流式展开、CRC、损坏及路径检查', async () => {
  const bytes = await docx()
  assert(directory(bytes).length > 5)
  assert((await unpack(bytes)).some((p) => p.name === 'word/document.xml'))
  assert.throws(() => directory(new Uint8Array(ZIP_LIMIT + 1)), /budget/)
  await assert.rejects(unpack(new Uint8Array([1, 2, 3])))
  const stored = await zipOf({ 'a.xml': '<a>hello</a>' }, 'STORE')
  stored[35] ^= 1
  await assert.rejects(unpack(stored))
  await assert.rejects(unpack(await zipOf({ '../a.xml': '<a/>' })))
})
test('Office ZIP 炸弹：声明超限、伪报小长度都在库解析前拒绝', async () => {
  const bytes = await zipOf({ 'big.txt': 'x'.repeat(EXPANDED_LIMIT + 1) })
  await assert.rejects(unpack(bytes), /budget/)
  const v = new DataView(bytes.buffer)
  for (let at = 0; at < bytes.length - 46; at++)
    if (v.getUint32(at, true) === 0x02014b50) v.setUint32(at + 24, 10, true)
  await assert.rejects(unpack(bytes))
})
test('Office XML：实体、宏、嵌入对象与过深节点拒绝', async () => {
  for (const files of [
    { 'word/vbaProject.bin': 'macro' },
    { 'word/embeddings/object.bin': 'object' },
    { 'a.xml': '<!DOCTYPE a [<!ENTITY test "evil">]><a>&test;</a>' },
    { 'a.xml': '<a>'.repeat(130) + '</a>'.repeat(130) },
  ])
    await assert.rejects(unpack(await zipOf(files)))
})
test('XLSX：中文、长数字字符串、日期系统、缓存/无缓存公式、链接文本与合并', async () => {
  for (const date1904 of [false, true]) {
    const result = await spreadsheet(await unpack(await xlsx({ date1904 })))
    const sheet = result.sheets[0]
    assert.equal(result.sheets.length, 2)
    assert.equal(sheet.cells['2:3'], '001234567890123456789')
    assert.equal(sheet.cells['3:2'], '42')
    assert.equal(sheet.cells['4:2'], '=1+2')
    assert.equal(sheet.cells['4:3'], '外链作为文字')
    assert.equal(sheet.cells['5:2'], '2024-02-29')
    assert.equal(sheet.cells['6:2'], '12.5%')
    assert.deepEqual(sheet.merges, [{ top: 8, left: 1, bottom: 8, right: 3 }])
  }
})

test('XLSX：十万单元格和共享字符串预算在装载前生效', () => {
  const encoder = new TextEncoder()
  assert.throws(
    () =>
      checkSheets([
        {
          name: 'xl/worksheets/sheet1.xml',
          bytes: encoder.encode(
            `<worksheet><row r="1">${'<c r="A1"/>'.repeat(100_001)}</row></worksheet>`,
          ),
        },
      ]),
    /budget/,
  )
  assert.throws(
    () =>
      checkSheets([
        {
          name: 'xl/sharedStrings.xml',
          bytes: encoder.encode(`<sst>${'<si/>'.repeat(100_001)}</sst>`),
        },
      ]),
    /budget/,
  )
})
test('XLSX：真实 XML 属性解析拦坐标/合并炸弹，假属性文本和实体编码不能绕过', () => {
  const check = (xml) =>
    checkSheets([{ name: 'xl/worksheets/sheet1.xml', bytes: new TextEncoder().encode(xml) }])
  for (const xml of [
    '<worksheet><row r="10001"/></worksheet>',
    '<worksheet><row r="1"><c foo="r=\'A1\'" r="XFD1"/></row></worksheet>',
    '<worksheet><row r="1"><c r="A1000&#49;"/></row></worksheet>',
    '<worksheet><mergeCell ref="A1:GR10000"/></worksheet>',
  ])
    assert.throws(() => check(xml))
})

test('XLSX：巨型命名区域、数据验证、列定义不进入 ExcelJS 展开路径', async () => {
  const parts = await unpack(await xlsx())
  const enc = new TextEncoder(),
    dec = new TextDecoder()
  for (const part of parts) {
    let xml = dec.decode(part.bytes)
    if (part.name === 'xl/workbook.xml')
      xml = xml.replace(
        '</workbook>',
        '<definedNames><definedName name="EntireBook">数据表!$A$1:$XFD$1048576</definedName></definedNames></workbook>',
      )
    if (part.name === 'xl/worksheets/sheet1.xml')
      xml = xml.replace(
        '</worksheet>',
        '<cols><col min="1" max="4294967295" width="10"/></cols><dataValidations><dataValidation sqref="A1:XFD1048576" type="whole"><formula1>0</formula1></dataValidation></dataValidations></worksheet>',
      )
    if (part.name.endsWith('.xml')) part.bytes = enc.encode(xml)
  }
  const result = await spreadsheet(parts)
  assert.equal(result.sheets[0].cells['3:2'], '42')
  assert.throws(
    () =>
      checkSheets([
        {
          name: 'xl/workbook.xml',
          bytes: enc.encode('<workbook><sheets><sheet sheetId="4294967295"/></sheets></workbook>'),
        },
      ]),
    /budget/,
  )
})

test('XLSX：共享字符串重复引用的输出文本也有累计预算', async () => {
  const parts = await unpack(await xlsx()),
    enc = new TextEncoder()
  const strings = parts.find((p) => p.name === 'xl/sharedStrings.xml')
  const sheet = parts.find((p) => p.name === 'xl/worksheets/sheet1.xml')
  // 保留其他索引，第二张表仍引用原来的 sharedStrings，避免夹具先因悬空索引损坏。
  strings.bytes = enc.encode(
    new TextDecoder()
      .decode(strings.bytes)
      .replace(/<t>[^<]*<\/t>/, `<t>${'x'.repeat(100_000)}</t>`),
  )
  sheet.bytes = enc.encode(
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Array.from({ length: 50 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="s"><v>0</v></c></row>`).join('')}</sheetData></worksheet>`,
  )
  await assert.rejects(spreadsheet(parts), /budget/)
})

test('XLSX：不同 sheet 关系不能重复指向同一工作表，拒绝发生在库装载前', async () => {
  const parts = await unpack(await xlsx())
  const rel = parts.find((p) => p.name === 'xl/_rels/workbook.xml.rels')
  rel.bytes = new TextEncoder().encode(
    new TextDecoder().decode(rel.bytes).replace('worksheets/sheet2.xml', 'worksheets/sheet1.xml'),
  )
  await assert.rejects(spreadsheet(parts), /invalid/)
})

test('XLSX：同一关系或规范化后的目标别名不能重复引用', async () => {
  const { checkSheetReferences } = await import('../src/files/preview/office/sheet-references.ts')
  for (const mode of ['same-id', 'absolute-target', 'dot-target', 'duplicate-rel']) {
    const parts = await unpack(await xlsx()),
      enc = new TextEncoder(),
      dec = new TextDecoder()
    const rel = parts.find((p) => p.name === 'xl/_rels/workbook.xml.rels')
    const workbook = parts.find((p) => p.name === 'xl/workbook.xml')
    if (mode === 'same-id')
      workbook.bytes = enc.encode(dec.decode(workbook.bytes).replace('r:id="rId5"', 'r:id="rId4"'))
    else if (mode === 'duplicate-rel')
      rel.bytes = enc.encode(dec.decode(rel.bytes).replace('Id="rId5"', 'Id="rId4"'))
    else
      rel.bytes = enc.encode(
        dec
          .decode(rel.bytes)
          .replace(
            'worksheets/sheet2.xml',
            mode === 'absolute-target' ? '/xl/worksheets/sheet1.xml' : 'worksheets/./sheet1.xml',
          ),
      )
    assert.throws(() => checkSheetReferences(parts), /invalid/, mode)
  }
})

test('XLSX：多个独占部件的单元格合计也必须在交库前符合预算', async () => {
  const { checkSheetReferences } = await import('../src/files/preview/office/sheet-references.ts')
  const parts = await unpack(await xlsx()),
    enc = new TextEncoder()
  const content = `<worksheet><sheetData>${Array.from({ length: 2501 }, (_, row) => `<row r="${row + 1}">${Array.from({ length: 20 }, (_, col) => `<c r="${String.fromCharCode(65 + col)}${row + 1}"/>`).join('')}</row>`).join('')}</sheetData></worksheet>`
  for (const part of parts)
    if (/^xl\/worksheets\/sheet[12]\.xml$/.test(part.name)) part.bytes = enc.encode(content)
  checkSheetReferences(parts)
  assert.throws(() => checkSheets(parts), /budget/)
})

test('DOCX MessagePort：只收固定形状与白名单错误码', async () => {
  const { frameResult } = await import('../src/files/preview/office/frame-result.ts')
  for (const value of [
    null,
    undefined,
    [],
    true,
    'budget',
    {},
    { ok: 1, isolated: true },
    { ok: true, isolated: false },
    { ok: false, error: 'unknown' },
    { ok: false, error: null },
    { error: 'budget' },
  ])
    assert.deepEqual(frameResult(value), { ok: false, error: 'invalid' })
  assert.equal(frameResult('ready'), 'ready')
  assert.deepEqual(frameResult({ ok: true, isolated: true, pages: 1 }), { ok: true })
  for (const error of ['budget', 'invalid', 'active', 'timeout'])
    assert.deepEqual(frameResult({ ok: false, error }), { ok: false, error })
})
