import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { collectLicenses } from '../apps/desktop/scripts/licenses.mjs'

test('许可收集按包位置解析嵌套依赖，两个版本都带原始许可和 NOTICE', () => {
  const temp = mkdtempSync(join(tmpdir(), 'litch-license-test-'))
  const root = join(temp, 'app'),
    out = join(temp, 'out')
  const put = (path, value) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, value)
  }
  const pkg = (path, name, version, dependencies = {}) => {
    put(join(path, 'package.json'), JSON.stringify({ name, version, license: 'MIT', dependencies }))
    put(join(path, 'LICENSE'), `license of ${name}@${version}`)
  }
  try {
    pkg(root, 'app', '1.0.0', { parent: '1.0.0', shared: '2.0.0' })
    pkg(join(root, 'node_modules/parent'), 'parent', '1.0.0', { shared: '1.0.0' })
    pkg(join(root, 'node_modules/shared'), 'shared', '2.0.0')
    pkg(join(root, 'node_modules/parent/node_modules/shared'), 'shared', '1.0.0')
    put(join(root, 'node_modules/parent/node_modules/shared/NOTICE'), 'nested notice')
    const list = collectLicenses(out, [root])
    assert.equal(list.length, 3)
    assert.match(readFileSync(join(out, 'shared@1.0.0.txt'), 'utf8'), /nested notice/)
    assert.match(readFileSync(join(out, 'shared@2.0.0.txt'), 'utf8'), /license of shared@2.0.0/)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
