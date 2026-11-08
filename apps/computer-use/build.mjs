// 只编译 Swift 源码；应用组装、身份、签名、公证和分发由宿主负责。
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url))

export function buildNative({ arch = process.arch, debug = false } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS 助手必须在 macOS 上构建')
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`不支持的 macOS 架构：${arch}`)
  const args = [
    'build',
    '--package-path',
    PACKAGE_DIR,
    '-c',
    debug ? 'debug' : 'release',
    '--arch',
    arch === 'x64' ? 'x86_64' : 'arm64',
  ]
  execFileSync('swift', args, { stdio: 'inherit' })
  const directory = execFileSync('swift', [...args, '--show-bin-path'], { encoding: 'utf8' }).trim()
  return join(directory, 'LitchComputerUse')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(buildNative({ debug: process.argv.includes('--debug') }))
