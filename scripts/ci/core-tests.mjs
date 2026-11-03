// 按源码清单选择已编译用例，避免重命名后残留的 dist 文件重新进入测试。
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function coreTestFiles(names, suite) {
  assert.ok(['portable', 'windows-native'].includes(suite), '未知核心测试集合')
  const suffix = suite === 'portable' ? '.test.mts' : '.windows-test.mts'
  const files = names.filter((name) => name.endsWith(suffix)).sort()
  assert.ok(files.length > 0, '核心测试集合不能为空')
  return files.map((name) => name.replace(/\.mts$/, '.mjs'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const suite = process.argv[2] ?? 'portable'
  if (suite === 'windows-native')
    assert.equal(process.platform, 'win32', 'Windows 原生用例必须在 Windows 上执行')
  const files = coreTestFiles(readdirSync(join(root, 'packages/core/test')), suite)
  const result = spawnSync(
    process.execPath,
    ['--test', ...files.map((name) => join(root, 'packages/core/dist/packages/core/test', name))],
    { stdio: 'inherit' },
  )
  if (result.error) throw result.error
  assert.equal(result.signal, null, '核心测试被中断')
  process.exitCode = result.status ?? 1
}
