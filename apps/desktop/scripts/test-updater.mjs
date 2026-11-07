// 临时目录、假 Electron 与文件命令；真实 Squirrel 验收见 check-updater-mac.mjs。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const app = fileURLToPath(new URL('..', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'litch-updater-tests-'))
try {
  const outfile = join(directory, 'updater.test.mjs')
  await build({
    entryPoints: [join(app, 'src/test/updater.test.mts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    alias: {
      electron: join(app, 'src/test/updater-electron.mts'),
      'node:child_process': join(app, 'src/test/updater-process.mts'),
      '@litch/core': join(app, '../../packages/core/src/index.mts'),
    },
    logLevel: 'warning',
  })
  process.exitCode =
    spawnSync(process.execPath, ['--test', outfile], { stdio: 'inherit' }).status ?? 1
} finally {
  rmSync(directory, { recursive: true, force: true })
}
