import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runtimeInfo } from '../src/versions.mjs'

test('重复读取 runtime/info 只探测一次，替换 CLI 后重查', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'litch-dsh-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cli = join(root, 'dsh.mjs')
  const counter = join(root, 'calls')
  const previous = process.env.CHA_DSH_CLI
  process.env.CHA_DSH_CLI = cli
  t.after(() => {
    if (previous === undefined) delete process.env.CHA_DSH_CLI
    else process.env.CHA_DSH_CLI = previous
  })
  const install = (version: string) =>
    writeFileSync(
      cli,
      `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(counter)}, '1'); console.log('${version}');\n`,
      { mode: 0o700 },
    )
  install('0.2.0-rc.2')
  for (let n = 0; n < 5; n++) assert.equal(runtimeInfo().cliBuild, '0.2.0-rc.2')
  assert.equal(readFileSync(counter, 'utf8'), '1')
  install('0.2.1-rc.12')
  assert.equal(runtimeInfo().cliBuild, '0.2.1-rc.12')
  assert.equal(readFileSync(counter, 'utf8'), '11')
})
