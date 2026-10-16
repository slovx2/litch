// Computer Use 主进程一侧的单元测试（src/computer-use/test/*.test.mts）：每个测试文件用 esbuild 打成一个文件放进
// 临时目录，再交给 node --test。助手用桩或假的套接字服务，不起真的应用、不碰系统权限。
//   node scripts/test-computer-use.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const testDir = fileURLToPath(new URL('../src/computer-use/test/', import.meta.url))
const files = readdirSync(testDir).filter((name) => name.endsWith('.test.mts'))
const out = mkdtempSync(join(tmpdir(), 'litch-cu-tests-'))
try {
  await build({
    entryPoints: files.map((name) => join(testDir, name)),
    outdir: out,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outExtension: { '.js': '.mjs' },
    packages: 'external',
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
