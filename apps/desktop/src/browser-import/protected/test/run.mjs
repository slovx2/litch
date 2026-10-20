// 从仓库根运行：node apps/desktop/src/browser-import/protected/test/run.mjs
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildKeychain } from '../native/build.mjs'

const directory = fileURLToPath(new URL('.', import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'litch-reader-tests-'))
try {
  buildKeychain({
    out: join(out, 'fake-keychain'),
    querySource: join(directory, 'fake-keychain.c'),
  })
  await build({
    entryPoints: readdirSync(directory)
      .filter((name) => name.endsWith('.test.mts'))
      .map((name) => join(directory, name)),
    outdir: out,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    external: ['node:*'],
    logLevel: 'warning',
  })
  process.exitCode =
    spawnSync(
      process.execPath,
      [
        '--test',
        '--test-concurrency=1',
        ...readdirSync(out)
          .filter((name) => name.endsWith('.test.mjs'))
          .map((name) => join(out, name)),
      ],
      { stdio: 'inherit' },
    ).status ?? 1
} finally {
  rmSync(out, { recursive: true, force: true })
}
