// 桌面端日志（src/log-file.mts）的单元测试：src/test/log-file.test.mts 打成一个文件放进临时目录，
// 再交给 node --test。日志都写在临时目录里，不碰真实的 ~/Library/Logs/Litch。
//   node scripts/test-log-file.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'litch-log-tests-'))
try {
  await build({
    entryPoints: [join(appDir, 'src/test/log-file.test.mts')],
    outdir: out,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['node:*'],
    logLevel: 'warning',
  })
  const result = spawnSync(process.execPath, ['--test', join(out, 'log-file.test.mjs')], {
    stdio: 'inherit',
  })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
