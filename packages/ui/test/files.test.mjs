// 往消息里加不是图片的文件：什么时候按路径提到它，什么时候把内容当文字带，什么时候带不了。
// 跑法：npm run test --prefix packages/ui（Node 直接读 .ts，不用先构建）。
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { baseName, decodeText, planFile, readFiles } = await import('../src/composer/files.ts')
const { TEXT_LIMIT } = await import('../src/composer/extras.ts')

const text = (name, body) => new File([body], name, { type: 'text/plain' })
const binary = (name) => new File([new Uint8Array([0x89, 0x50, 0, 1, 2, 0xff])], name)
/** 假装这些文件在磁盘上：名字就是路径的最后一段 */
const onDisk = (file) => `/Users/dev/work/${file.name}`
const nowhere = () => ''

test('怎么带：消息发给本机、又拿得到路径，才按路径提到它；别的都是把内容当文字带', () => {
  assert.equal(planFile(true, '/Users/dev/a.txt'), 'ref')
  assert.equal(planFile(true, ''), 'inline')
  assert.equal(planFile(false, '/Users/dev/a.txt'), 'inline')
  assert.equal(planFile(false, ''), 'inline')
})

test('是不是文本：按 UTF-8 解得出来、没有 NUL 的才算', () => {
  assert.equal(decodeText(new TextEncoder().encode('第一行\n第二行')), '第一行\n第二行')
  assert.equal(decodeText(new Uint8Array([0x61, 0, 0x62])), null)
  assert.equal(decodeText(new Uint8Array([0xff, 0xfe, 0x00])), null)
  assert.equal(baseName('/Users/dev/work/docs/'), 'docs')
  assert.equal(baseName('C:\\work\\a.txt'), 'a.txt')
})

test('本机设备、拿得到路径：什么文件都按路径提到，不读内容', async () => {
  const { extras, refused } = await readFiles([text('notes.md', '# 备忘'), binary('blob.bin')], {
    local: true,
    pathOf: onDisk,
    room: 16,
  })
  assert.deepEqual(extras, [
    { kind: 'file', name: 'notes.md', path: '/Users/dev/work/notes.md' },
    { kind: 'file', name: 'blob.bin', path: '/Users/dev/work/blob.bin' },
  ])
  assert.equal(refused, null)
})

test('远程设备：文本文件把内容带上（名字留着、换行统一），不是文本的带不了，说得出是哪个', async () => {
  const { extras, refused } = await readFiles(
    [text('notes.md', '# 备忘\r\n一行'), binary('blob.bin'), text('b.txt', '乙')],
    { local: false, pathOf: onDisk, room: 16 },
  )
  assert.deepEqual(extras, [
    { kind: 'text', name: 'notes.md', text: '# 备忘\n一行' },
    { kind: 'text', name: 'b.txt', text: '乙' },
  ])
  assert.deepEqual(refused, { why: 'binary', name: 'blob.bin' })
})

test('本机设备但拿不到路径（不在桌面外壳里）：和远程一样，只带得了文本文件的内容', async () => {
  const { extras, refused } = await readFiles([binary('blob.bin'), text('a.txt', '甲')], {
    local: true,
    pathOf: nowhere,
    room: 16,
  })
  assert.deepEqual(extras, [{ kind: 'text', name: 'a.txt', text: '甲' }])
  assert.deepEqual(refused, { why: 'binary', name: 'blob.bin' })
})

test('带不了的几种：空的、太长的、满了的', async () => {
  const facts = { local: false, pathOf: nowhere, room: 16 }
  assert.deepEqual((await readFiles([text('empty.txt', ' \n')], facts)).refused, {
    why: 'empty',
    name: 'empty.txt',
  })
  assert.deepEqual(
    (await readFiles([text('big.log', 'x'.repeat(TEXT_LIMIT + 1))], facts)).refused,
    {
      why: 'size',
      name: 'big.log',
    },
  )
  const full = await readFiles([text('a.txt', '甲'), text('b.txt', '乙')], { ...facts, room: 1 })
  assert.equal(full.extras.length, 1)
  assert.deepEqual(full.refused, { why: 'count', name: 'b.txt' })
})
