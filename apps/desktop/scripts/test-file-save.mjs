// 所有写入只到临时目录；Electron 和系统保存对话框完全由夹具代答。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const app = fileURLToPath(new URL('..', import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'litch-save-tests-'))
try {
  await build({
    entryPoints: ['file-save', 'file-save-main', 'file-save-device', 'file-reveal'].map((name) =>
      join(app, `src/test/${name}.test.mts`),
    ),
    outdir: out,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    alias: { electron: join(app, 'src/test/file-save-electron.mts') },
    logLevel: 'warning',
    external: ['bufferutil', 'utf-8-validate'],
    banner: {
      js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);",
    },
  })
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      ...['file-save', 'file-save-main', 'file-save-device', 'file-reveal'].map((name) =>
        join(out, `${name}.test.mjs`),
      ),
    ],
    { stdio: 'inherit' },
  )
  process.exitCode = result.status ?? 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
