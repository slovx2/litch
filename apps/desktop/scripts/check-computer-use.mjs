// Computer Use 的端到端自检。Windows 上走 check-computer-use-win.mjs（起助手、hello、diagnostics、listApps、退出）：
//   node scripts/check-computer-use.mjs [--helper 助手的路径] [--require]
// 下面是 macOS 的：组装一份临时签名的助手，真的经 LaunchServices 拉起、握手，
// 调不要授权的几样，确认该拒的连接被拒、被杀后会重拉、退出后不留进程。不点、不截图、不打字，不需要任何系统授权。
// 给了开发者身份（--identity 或 LITCH_SIGN_IDENTITY）时再签一份，确认正式版的助手不认 Node（只认同团队签名的 Litch）。
//   node scripts/check-computer-use.mjs [--identity 证书名或SHA-1]
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildHelper, HELPER_APP_NAME, signHelper } from '../../computer-use/build-app.mjs'

const here = (path) => fileURLToPath(new URL(path, import.meta.url))
const option = (name) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
if (process.platform === 'win32') {
  const { checkWindowsHelper } = await import('./check-computer-use-win.mjs')
  try {
    const lines = await checkWindowsHelper({
      helper: option('--helper'),
      require: process.argv.includes('--require'),
    })
    for (const line of lines) console.log(`✔ ${line}`)
    process.exit(0)
  } catch (error) {
    console.error(`✘ ${error.message}`)
    process.exit(1)
  }
}
if (process.platform !== 'darwin') {
  console.log('Computer Use 只在 macOS 和 Windows 上有，跳过')
  process.exit(0)
}
// 套接字路径有长度上限，临时目录放在 /tmp 下
const root = mkdtempSync('/tmp/litch-cu-check-')
let failed = false
try {
  const app = buildHelper({ out: join(root, 'adhoc') })
  signHelper(app, {})
  await build({
    entryPoints: [here('../src/computer-use/self-check.mts')],
    outfile: join(root, 'self-check.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    packages: 'external',
    logLevel: 'warning',
  })
  const check = await import(join(root, 'self-check.mjs'))
  for (const line of await check.checkAdhoc(app, join(root, 'profile'))) console.log(`✔ ${line}`)

  const identity = option('--identity') ?? process.env.LITCH_SIGN_IDENTITY
  if (identity) {
    const signed = join(root, 'team', HELPER_APP_NAME)
    cpSync(app, signed, { recursive: true })
    signHelper(signed, { identity, keychain: process.env.LITCH_SIGN_KEYCHAIN })
    for (const line of await check.checkTeamSigned(signed, join(root, 'team-dir'))) {
      console.log(`✔ ${line}`)
    }
  } else {
    console.log('（没给开发者身份，跳过正式版验签的那一段）')
  }
} catch (error) {
  failed = true
  console.error(`✘ ${error.stack ?? error.message}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
