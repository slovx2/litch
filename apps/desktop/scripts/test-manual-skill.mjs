// 产品手册注入（src/manual-skill.mts）的单元测试：src/test/manual-skill.test.mts 打成一个文件放进临时目录，
// 再交给 node --test。测试在临时目录里当主目录，不碰真实的 ~/.agents、~/.claude。手册的源用仓库里的 skills/litch-manual。
//   node scripts/test-manual-skill.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'litch-manual-tests-'))
try {
  await build({
    entryPoints: [join(appDir, 'src/test/manual-skill.test.mts')],
    outdir: out,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    external: ['node:*'],
    logLevel: 'warning',
  })
  const result = spawnSync(process.execPath, ['--test', join(out, 'manual-skill.test.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, LITCH_MANUAL_SOURCE: join(appDir, '../../skills/litch-manual') },
  })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
