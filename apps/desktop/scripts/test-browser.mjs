// 内置浏览器的单元测试（src/browser/test/*.test.mts，以及从别的浏览器导入的 src/browser-import/test/*.test.mts；读取器的测试要先编原生替身，交给它自己的 src/browser-import/protected/test/run.mjs，跑在后面）：不起 Electron。测试文件各打成一个包放进临时目录，
// 再交给 node --test。被测的模块不许引 electron（执行器、网址、审批记录、按键、快照排版、白名单）。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const testDirs = ['src/browser/test', 'src/browser-import/test'].map((dir) => join(appDir, dir))
const entries = testDirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.test.mts'))
    .map((name) => join(dir, name)),
)
const out = mkdtempSync(join(tmpdir(), 'litch-browser-test-'))
try {
  await build({
    entryPoints: entries,
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
  // 几个目录的入口打出来按目录分开放
  const outputs = readdirSync(out, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => join(out, name))
  const result = spawnSync(process.execPath, ['--test', ...outputs], { stdio: 'inherit' })
  const reader = spawnSync(
    process.execPath,
    [join(appDir, 'src/browser-import/protected/test/run.mjs')],
    {
      stdio: 'inherit',
    },
  )
  process.exitCode = (result.status ?? 1) || (reader.status ?? 1)
} finally {
  rmSync(out, { recursive: true, force: true })
}
