// 从已取到本地的独立仓提交生成源码清单；先校验工作树逐字节一致，不替未回写修改背书。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const commit = process.argv[2]
assert.match(commit ?? '', /^[a-f0-9]{40}$/, '请传入完整独立仓提交 SHA')
const git = (...args) => execFileSync('git', args, { cwd: fileURLToPath(root) })
const tree = git('rev-parse', `${commit}^{tree}`).toString().trim()
const entries = git('ls-tree', '-r', '-z', commit).toString().split('\0').filter(Boolean)
const files = {}
for (const entry of entries) {
  const [metadata, path] = entry.split('\t')
  const [mode, type, object] = metadata.split(' ')
  assert.ok(type === 'blob' && ['100644', '100755'].includes(mode), `不支持的源码类型：${path}`)
  const source = git('cat-file', 'blob', object)
  assert.deepEqual(
    readFileSync(new URL(`third_party/litch-automation/${path}`, root)),
    source,
    `源码与上游提交不符：${path}`,
  )
  files[path] = createHash('sha256').update(source).digest('hex')
}
const lock = { repository: 'https://github.com/slovx2/litch-automation.git', commit, tree, files }
const output = new URL('third_party/litch-automation.lock.json', root)
const lines = `${JSON.stringify(lock, null, 2)}\n`.split('\n')
writeFileSync(output, '')
for (let index = 0; index < lines.length; index += 200)
  writeFileSync(output, `${index ? '\n' : ''}${lines.slice(index, index + 200).join('\n')}`, {
    flag: 'a',
  })
console.log(`独立源码清单已更新：${commit}，${entries.length} 个文件`)
