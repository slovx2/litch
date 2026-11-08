// 校验 subtree 的固定源码清单；从源码归档构建时也不需要 Git 或额外网络。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const prefix = 'third_party/litch-automation/'
const lock = JSON.parse(readFileSync(new URL(`${prefix.slice(0, -1)}.lock.json`, root), 'utf8'))
assert.equal(lock.repository, 'https://github.com/slovx2/litch-automation.git')
assert.match(lock.commit, /^[a-f0-9]{40}$/)
assert.match(lock.tree, /^[a-f0-9]{40}$/)
const paths = Object.keys(lock.files).sort()
assert.ok(paths.length > 200, '独立源码清单不完整')
for (const path of paths) {
  assert.ok(!path.startsWith('/') && !path.split('/').includes('..'), '清单路径越界')
  const file = new URL(`${prefix}${path}`, root)
  assert.ok(lstatSync(file).isFile(), `源码不是普通文件：${path}`)
  assert.equal(
    createHash('sha256').update(readFileSync(file)).digest('hex'),
    lock.files[path],
    `独立源码已变更、需先回写并更新清单：${path}`,
  )
}
if (existsSync(new URL('.git', root))) {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', prefix], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .map((path) => path.slice(prefix.length))
    .sort()
  assert.deepEqual(tracked, paths, 'Git 跟踪的源码与清单不一致')
}
console.log(`独立源码校验通过：${lock.commit}，${paths.length} 个文件`)
