// 定向验收远程工作证据及本机控制通道；不会连接真实设备或持有休眠断言。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const app = fileURLToPath(new URL('..', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'litch-power-tests-'))
try {
  const output = join(directory, 'remote-power.test.mjs')
  await build({
    entryPoints: [join(app, 'src/test/remote-power.test.mts')],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
  })
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=10000', output], {
    stdio: 'inherit',
    env: { ...process.env, HOME: directory, CODEX_HOME: join(directory, 'codex') },
  })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(directory, { recursive: true, force: true })
}
