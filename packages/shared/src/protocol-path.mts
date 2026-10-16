import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 测试从源码或编译输出定位本仓库协议，不依赖工作目录或相邻仓库。
export function protocolDirectory(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  while (directory !== dirname(directory)) {
    const candidate = join(directory, 'protocol/codex-app-server/0.157.1/json-schema')
    if (existsSync(candidate)) return candidate
    directory = dirname(directory)
  }
  throw new Error('缺少 codex-harness-adapter 协议契约')
}
