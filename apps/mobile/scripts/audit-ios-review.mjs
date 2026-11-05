// 检查最终 .app，不以源码已删属性替代产物证据。只读，不改签名或包内容。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function auditIOSReview(app, e2e = false) {
  const info = JSON.parse(
    execFileSync('plutil', ['-convert', 'json', '-o', '-', join(app, 'Info.plist')]),
  )
  const config = JSON.parse(readFileSync(join(app, 'EXConstants.bundle/app.config'), 'utf8'))
  assert.equal(config.extra?.litchE2E, e2e, '包内 Expo 构建档位不符合预期')
  const binaries = [join(app, info.CFBundleExecutable)]
  const frameworks = join(app, 'Frameworks')
  if (existsSync(frameworks))
    for (const name of readdirSync(frameworks)) {
      if (name.endsWith('.framework'))
        binaries.push(join(frameworks, name, basename(name, '.framework')))
      else if (name.endsWith('.dylib')) binaries.push(join(frameworks, name))
    }
  for (const file of binaries) {
    const symbols = execFileSync('strings', [file], {
      encoding: 'utf8',
      maxBuffer: 96 * 1024 * 1024,
    })
    assert.doesNotMatch(
      symbols,
      /_elementDidFocus:|_startAssistingNode:|_SwizzleHelperWK|__addInputAccessoryView/,
      `仍有 WebView 私有键盘路径：${basename(file)}`,
    )
  }
  return { bundleId: info.CFBundleIdentifier, e2e, nativeBinaries: binaries.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2], '必须传入 .app 的绝对路径')
  console.log(
    JSON.stringify(auditIOSReview(resolve(process.argv[2]), process.argv.includes('--e2e'))),
  )
}
