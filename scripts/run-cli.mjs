#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const executable = fileURLToPath(
  new URL(
    `../bin/codex-harness-adapter${process.platform === 'win32' ? '.exe' : ''}`,
    import.meta.url,
  ),
)
const child = spawn(executable, process.argv.slice(2), { stdio: 'inherit' })
// POSIX 通过包装器终止时仍交给 Go 入口回收整个运行时组；Windows 控制台广播 Ctrl-C。
if (process.platform !== 'win32') {
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
}
child.on('error', (error) => {
  console.error(`无法启动适配器，请先运行 npm run setup 完成安装和构建：${error.message}`)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
