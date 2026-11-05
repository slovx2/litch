// 根模块与手机模块分别锁定 Go；切换工具链只作用于子进程，不改全局配置。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../../', import.meta.url))

export function goToolchain(module = '.', root = repository) {
  const source = readFileSync(join(root, module, 'go.mod'), 'utf8')
  const version = /^go (\d+\.\d+\.\d+)\s*$/m.exec(source)?.[1]
  assert.ok(version, `${module}/go.mod 必须固定 Go 补丁版本`)
  return `go${version}`
}

export function goEnvironment(module = '.', source = process.env, root = repository) {
  return { ...source, GOTOOLCHAIN: goToolchain(module, root) }
}
