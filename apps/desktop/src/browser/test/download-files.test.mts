import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  copyDownloadFile,
  publishDownloadFile,
} from '../../../../../packages/browser/src/browser/download-files.mjs'

test('发布与跨卷复制均不覆盖目标，保留内容及本平台隔离元数据', async () => {
  const root = mkdtempSync(join(tmpdir(), 'litch-download-files-'))
  try {
    const source = join(root, 'source')
    const linked = join(root, 'linked')
    const copied = join(root, 'copied')
    writeFileSync(source, 'download fixture')
    const quarantine = '0081;00000000;Litch Probe;'
    if (process.platform === 'darwin')
      execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantine, source])
    await publishDownloadFile(source, linked)
    await copyDownloadFile(source, copied)
    for (const path of [linked, copied]) {
      assert.equal(readFileSync(path, 'utf8'), 'download fixture')
      if (process.platform === 'darwin')
        assert.equal(
          execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path], {
            encoding: 'utf8',
          }).trim(),
          quarantine,
        )
    }
    await assert.rejects(copyDownloadFile(source, copied), { code: 'EEXIST' })
    await assert.rejects(publishDownloadFile(source, linked), { code: 'EEXIST' })
    assert.equal(readFileSync(copied, 'utf8'), 'download fixture')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
