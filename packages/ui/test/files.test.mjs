// 往消息里加不是图片的文件、文件夹：什么时候按路径提到它，什么时候把内容当文字带，什么时候带不了。
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
const folder = (name) => new File([], name)
/** 认得出的文件夹：名字里不带点的当文件夹（测试用的约定） */
const byName = (file) => !file.name.includes('.')
const noFolders = () => false
const local = { local: true, machine: null, isFolder: noFolders }
const remote = { local: false, machine: 'off', isFolder: noFolders }

test('怎么带：消息发给本机、又拿得到路径，才按路径提到它；远程设备的文件夹看开没开“操作这台电脑”', () => {
  const on = { local: false, machine: 'on' }
  const off = { local: false, machine: 'off' }
  assert.equal(planFile({ local: true, machine: null }, '/Users/dev/a.txt', false), 'ref')
  assert.equal(planFile({ local: true, machine: null }, '/Users/dev/docs', true), 'ref')
  assert.equal(planFile({ local: true, machine: null }, '', false), 'inline')
  assert.equal(planFile({ local: true, machine: null }, '', true), 'refuse')
  assert.equal(planFile(off, '/Users/dev/a.txt', false), 'inline')
  assert.equal(planFile(on, '/Users/dev/a.txt', false), 'inline')
  assert.equal(planFile(off, '', false), 'inline')
  assert.equal(planFile(on, '/Users/dev/docs', true), 'client')
  assert.equal(planFile(off, '/Users/dev/docs', true), 'refuse')
  assert.equal(planFile({ local: false, machine: null }, '/Users/dev/docs', true), 'refuse')
  assert.equal(planFile(on, '', true), 'refuse')
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
    ...local,
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
    { ...remote, pathOf: onDisk, room: 16 },
  )
  assert.deepEqual(extras, [
    { kind: 'text', name: 'notes.md', text: '# 备忘\n一行' },
    { kind: 'text', name: 'b.txt', text: '乙' },
  ])
  assert.deepEqual(refused, { why: 'binary', name: 'blob.bin' })
})

test('本机设备但拿不到路径（不在桌面外壳里）：和远程一样，只带得了文本文件的内容', async () => {
  const { extras, refused } = await readFiles([binary('blob.bin'), text('a.txt', '甲')], {
    ...local,
    pathOf: nowhere,
    room: 16,
  })
  assert.deepEqual(extras, [{ kind: 'text', name: 'a.txt', text: '甲' }])
  assert.deepEqual(refused, { why: 'binary', name: 'blob.bin' })
})

test('带不了的几种：空的、太长的、满了的', async () => {
  const facts = { ...remote, pathOf: nowhere, room: 16 }
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

test('本机设备的文件夹：按路径提到，路径末尾补 /，标成文件夹；拿不到路径的读不出来', async () => {
  const found = await readFiles([folder('docs'), text('a.md', '甲')], {
    ...local,
    isFolder: byName,
    pathOf: onDisk,
    room: 16,
  })
  assert.deepEqual(found.extras, [
    { kind: 'file', name: 'docs', path: '/Users/dev/work/docs/', folder: true },
    { kind: 'file', name: 'a.md', path: '/Users/dev/work/a.md' },
  ])
  assert.equal(found.refused, null)
  const lost = await readFiles([folder('docs')], {
    ...local,
    isFolder: byName,
    pathOf: nowhere,
    room: 16,
  })
  assert.deepEqual(lost, { extras: [], refused: { why: 'read', name: 'docs' } })
})

test('远程设备开了“操作这台电脑”：文件夹、二进制文件按这台电脑上的路径提到，文本文件照旧带内容', async () => {
  const { extras, refused } = await readFiles(
    [folder('sa攻略'), binary('blob.bin'), text('b.txt', '乙')],
    { local: false, machine: 'on', isFolder: byName, pathOf: onDisk, room: 16 },
  )
  assert.deepEqual(extras, [
    { kind: 'file', name: 'sa攻略', path: '/Users/dev/work/sa攻略/', folder: true, client: true },
    { kind: 'file', name: 'blob.bin', path: '/Users/dev/work/blob.bin', client: true },
    { kind: 'text', name: 'b.txt', text: '乙' },
  ])
  assert.equal(refused, null)
})

test('远程设备没开“操作这台电脑”：文件夹带不了，说得出是哪个', async () => {
  const { extras, refused } = await readFiles([folder('sa攻略'), text('b.txt', '乙')], {
    ...remote,
    isFolder: byName,
    pathOf: onDisk,
    room: 16,
  })
  assert.deepEqual(extras, [{ kind: 'text', name: 'b.txt', text: '乙' }])
  assert.deepEqual(refused, { why: 'folder', name: 'sa攻略' })
})
