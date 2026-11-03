// 三种去向使用同一套入口；上传之前不把二进制或文本内容并入模型正文。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_ATTACHMENT_BYTES } from '../../protocol/src/file-attachments.mts'
import { baseName, filesOf, planFile, readFiles } from '../src/composer/files.ts'

const file = (name, body = '内容') => new File([body], name, { type: 'text/plain' })
const localPath = (f) => `/Users/dev/${f.name}`
const facts = (more = {}) => ({
  local: false,
  machine: 'off',
  pathOf: localPath,
  isFolder: () => false,
  room: 16,
  upload: async () => {
    throw new Error('不该上传')
  },
  ...more,
})

test('本机、远程可操作本机、远程不可访问：文本和二进制采用相同规则', () => {
  assert.equal(planFile(facts({ local: true }), '/local/a.txt', false), 'ref')
  assert.equal(planFile(facts({ machine: 'on' }), '/local/a.txt', false), 'client')
  assert.equal(planFile(facts(), '/local/a.txt', false), 'upload')
  assert.equal(planFile(facts({ local: true }), '', false), 'upload')
  assert.equal(planFile(facts({ machine: 'on' }), '', false), 'upload')
  assert.equal(planFile(facts(), '/local/folder', true), 'refuse')
})
for (const [local, machine, client] of [
  [true, null, false],
  [false, 'on', true],
]) {
  test(`有可访问路径时不读文件、不上传：local=${local}`, async () => {
    const a = file('很长的中文文件名.pdf', new Uint8Array([255, 0, 1]))
    a.arrayBuffer = () => {
      throw new Error('不该读内容')
    }
    const result = await readFiles([a], facts({ local, machine }))
    assert.equal(result.refused, null)
    assert.deepEqual(result.extras, [
      {
        kind: 'file',
        name: a.name,
        path: localPath(a),
        size: 3,
        mimeType: 'text/plain',
        ...(client ? { client: true } : {}),
      },
    ])
  })
}
test('远程无访问能力：保留内容字节上传，空文件也接受', async () => {
  const seen = []
  const result = await readFiles(
    [file('binary.bin', new Uint8Array([0, 255, 1])), file('empty.txt', '')],
    facts({
      upload: async (f) => {
        seen.push([...new Uint8Array(await f.arrayBuffer())])
        return { kind: 'file', name: f.name, path: `/remote/${f.name}` }
      },
    }),
  )
  assert.deepEqual(seen, [[0, 255, 1], []])
  assert.equal(result.refused, null)
  assert.equal(result.extras[0].path, '/remote/binary.bin')
  assert.equal(result.extras[1].size, 0)
})
test('上传上限、失败和附件数量不会产生假卡片', async () => {
  let calls = 0
  const big = file('big')
  Object.defineProperty(big, 'size', { value: MAX_ATTACHMENT_BYTES + 1 })
  const result = await readFiles(
    [big, file('bad')],
    facts({
      upload: async () => {
        calls++
        throw new Error('offline')
      },
    }),
  )
  assert.deepEqual(result.extras, [])
  assert.deepEqual(result.refused, { why: 'size', name: 'big' })
  assert.equal(calls, 1)
  assert.deepEqual((await readFiles([file('bad')], facts())).refused, {
    why: 'upload',
    name: 'bad',
  })
  assert.equal((await readFiles([file('a')], facts({ room: 0 }))).refused.why, 'count')
})
test('文件夹只有可访问路径才接受，拖放和粘贴识别目录', async () => {
  const folder = file('docs', '')
  const result = await readFiles([folder], facts({ local: true, isFolder: () => true }))
  assert.deepEqual(result.extras, [
    { kind: 'file', name: 'docs', path: '/Users/dev/docs/', folder: true },
  ])
  assert.equal((await readFiles([folder], facts({ isFolder: () => true }))).refused.why, 'folder')
  assert.equal(
    (await readFiles([folder], facts({ local: true, pathOf: () => '', isFolder: () => true })))
      .refused.why,
    'read',
  )
  const data = {
    items: [
      { kind: 'file', getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) },
    ],
    files: [folder],
  }
  assert.ok(filesOf(data).folders.has(folder))
  assert.equal(baseName('C:\\work\\a.txt'), 'a.txt')
})

test('编辑发送失败的文件引用放回草稿，输入区尚未挂载也不会丢失', async () => {
  const { refillDraft, loadDraftExtras, onRefill } = await import('../src/composer/drafts.ts')
  const attachment = { kind: 'file', name: 'a.pdf', path: '/remote/a.pdf', size: 10 }
  refillDraft('failed-file', '再试', [], [attachment])
  assert.deepEqual(loadDraftExtras('failed-file'), [attachment])
  let got
  const stop = onRefill('open-file', (...args) => {
    got = args
  })
  refillDraft('open-file', '再试', [], [attachment])
  assert.deepEqual(got, ['再试', [], [attachment]])
  stop()
})
