// Litch 自己拥有 Windows 助手的产品身份；通用 Rust 源码只读取显式构建变量。
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../../../', import.meta.url)
const version = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version
const args = process.argv.slice(2)
const result = spawnSync(
  'cargo',
  args.length ? args : ['build', '--release', '--locked', '--target', 'x86_64-pc-windows-msvc'],
  {
    cwd: fileURLToPath(new URL('apps/computer-use-win/', root)),
    stdio: 'inherit',
    env: {
      ...process.env,
      CU_HELPER_VERSION: version,
      CU_HOST_PRODUCT: 'Litch',
      CU_HOST_REGISTRY_KEY:
        'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{86165537-655A-4F60-847F-94A1A6C622F4}_is1',
      CU_HOST_EXECUTABLE: 'Litch.exe',
      CU_HOST_ISOLATION_KEYS: 'LITCH_PROFILE;LITCH_MOCK',
    },
  },
)
if (result.error) throw result.error
if (result.signal) throw new Error(`Cargo 被 ${result.signal} 中断`)
process.exitCode = result.status ?? 1
