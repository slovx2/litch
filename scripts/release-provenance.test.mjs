import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { artifactKinds, verifyProvenance, writeProvenance } from './release-provenance.mjs'

test('同 SHA、同 run 和五种产物 hash 全部匹配才晋级', () => {
  const dir = mkdtempSync(join(tmpdir(), 'litch-provenance-'))
  const sha = 'a'.repeat(40)
  try {
    // 用独立目录模拟并行 runner，最后才把产物合并到晋级目录。
    for (const kind of artifactKinds) {
      const source = mkdtempSync(join(tmpdir(), 'litch-artifact-'))
      try {
        writeFileSync(join(source, `${kind}.zip`), kind)
        const proof = writeProvenance(source, kind, sha, '42')
        writeFileSync(join(dir, `${kind}.zip`), kind)
        writeFileSync(join(dir, `release-provenance-${kind}.json`), JSON.stringify(proof))
      } finally {
        rmSync(source, { recursive: true, force: true })
      }
    }
    const gate = { sha, run: '42', conclusion: 'success' }
    const saveGate = (value) => writeFileSync(join(dir, 'gate-proof.json'), JSON.stringify(value))
    saveGate(gate)
    assert.equal(verifyProvenance(dir, sha, '42'), 5)
    saveGate({ ...gate, sha: 'b'.repeat(40) })
    assert.throws(() => verifyProvenance(dir, sha, '42'), /门禁/)
    saveGate(gate)
    assert.throws(() => verifyProvenance(dir, sha, '43'), /门禁/)
    writeFileSync(join(dir, 'android.zip'), 'changed')
    assert.throws(() => verifyProvenance(dir, sha, '42'), /hash/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
