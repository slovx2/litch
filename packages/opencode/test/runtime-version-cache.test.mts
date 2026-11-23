import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runtimeInfo } from '../src/versions.mjs'

test('重复读取 OpenCode runtime/info 复用版本探测，原地升级后重新探测', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'litch-opencode-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cli = join(root, 'opencode.mjs')
  const counter = join(root, 'calls')
  const previous = process.env.CHA_OPENCODE_CLI
  process.env.CHA_OPENCODE_CLI = cli
  t.after(() => {
    if (previous === undefined) delete process.env.CHA_OPENCODE_CLI
    else process.env.CHA_OPENCODE_CLI = previous
  })
  const install = (version: string) =>
    writeFileSync(
      cli,
      `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(counter)}, '1'); console.log('${version}');\n`,
      { mode: 0o700 },
    )
  install('1.18.33')
  for (let n = 0; n < 5; n++) assert.equal(runtimeInfo().cliBuild, '1.18.33')
  assert.equal(readFileSync(counter, 'utf8'), '1')
  install('1.18.100')
  assert.equal(runtimeInfo().cliBuild, '1.18.100')
  assert.equal(readFileSync(counter, 'utf8'), '11')
})
