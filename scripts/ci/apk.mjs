// 构建作业封存 APK；每片核对构建作业输出、制品清单、本地源码，禁止自行重建另一份包。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [mode, directory, source] = process.argv.slice(2)
if (!['seal', 'verify'].includes(mode) || !directory)
  throw new Error('用法：apk.mjs seal|verify 目录 [源 APK]')
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
mkdirSync(directory, { recursive: true })
const apk = join(directory, 'app-release.apk')
const manifest = join(directory, 'manifest.json')
if (mode === 'seal') copyFileSync(source, apk)
const hash = createHash('sha256').update(readFileSync(apk)).digest('hex')
if (mode === 'seal') {
  writeFileSync(manifest, `${JSON.stringify({ sha, hash, architecture: 'x86_64' }, null, 2)}\n`)
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\nhash=${hash}\n`)
} else {
  const expected = JSON.parse(readFileSync(manifest, 'utf8'))
  if (
    expected.sha !== sha ||
    expected.sha !== process.env.EXPECTED_SOURCE_SHA ||
    expected.hash !== hash ||
    hash !== process.env.EXPECTED_APK_HASH ||
    expected.architecture !== 'x86_64'
  ) {
    throw new Error('APK 摘要/源码/架构与唯一构建作业不一致')
  }
}
const text = `APK ${mode}: source=${sha}, sha256=${hash}, arch=x86_64`
console.log(text)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
