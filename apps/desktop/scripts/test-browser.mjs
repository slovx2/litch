// 内置浏览器的单元测试（src/browser/test/*.test.mts）：不起 Electron。测试文件各打成一个包放进临时目录，
// 再交给 node --test。被测的模块不许引 electron（执行器、网址、审批记录、按键、快照排版、白名单）。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const testDir = join(appDir, 'src/browser/test')
const files = readdirSync(testDir).filter((name) => name.endsWith('.test.mts'))
const out = mkdtempSync(join(tmpdir(), 'litch-browser-test-'))
try {
  await build({
    entryPoints: files.map((name) => join(testDir, name)),
    outdir: out,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // 引到 electron 就是测试写错了：打包时直接报出来
    external: ['node:*'],
    logLevel: 'warning',
  })
  const outputs = readdirSync(out)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => join(out, name))
  const result = spawnSync(process.execPath, ['--test', ...outputs], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
