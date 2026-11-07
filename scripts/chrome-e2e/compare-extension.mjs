// 基线必须是调用者从指定提交重新导出的源码目录；不拿旧 dist 当作基线。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildChromeExtension } from '../../apps/desktop/scripts/build-chrome.mjs'

const baselineRoot = resolve(process.argv[2] ?? '.local/chrome-baseline')
const output = resolve(process.argv[3] ?? '.local/chrome-comparison')
await mkdir(output, { recursive: true })
const baseline = await import(
  pathToFileURL(join(baselineRoot, 'apps/desktop/scripts/build-chrome.mjs'))
)
const before = await baseline.buildChromeExtension(join(output, 'before'))
const after = await buildChromeExtension(join(output, 'after'))
assert.equal(before.id, after.id)
const files = [
  ...new Set([...(await readdir(before.directory)), ...(await readdir(after.directory))]),
].sort()
const results = []
for (const file of files) {
  const oldBytes = await readFile(join(before.directory, file)).catch(() => null)
  const newBytes = await readFile(join(after.directory, file)).catch(() => null)
  const hash = (bytes) => bytes && createHash('sha256').update(bytes).digest('hex')
  results.push({
    file,
    identical: !!oldBytes && !!newBytes && oldBytes.equals(newBytes),
    before: { bytes: oldBytes?.length ?? 0, sha256: hash(oldBytes) },
    after: { bytes: newBytes?.length ?? 0, sha256: hash(newBytes) },
  })
}
const report = {
  baseline: 'f39ec336',
  id: after.id,
  version: after.version,
  files: results,
  requiresStoreReview: results.some((file) => !file.identical),
}
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
// 明确允许记录 runtime bundle 的差异，其他交付文件必须保持逐字节一致。
assert.ok(results.filter((file) => file.file !== 'background.js').every((file) => file.identical))
