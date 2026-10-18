#!/usr/bin/env node
// 生成应用自己的更新清单 litch-update.json（形状和读法见 packages/core/src/update-feed.mts），发版流程的 publish 作业调用：
//   node scripts/update-manifest.mjs --dir <放着这一版全部文件的目录> --tag v0.9.0 --repo slovx2/litch
// 目录里要有这三个包（缺一个就报错，不出缺项的清单）：
//   Litch-<版本>-macos-arm64.zip         签名、公证、钉票后的应用打的 zip（macOS 的 Squirrel 下这个）
//   Litch-<版本>-windows-x64-setup.exe   Windows 的安装程序
//   Litch-<版本>-android-arm64.apk       发版钥匙签的安卓包
// 清单写在同一个目录里。地址指向这个标签的发布页下面的同名文件。
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    tag: { type: 'string' },
    repo: { type: 'string' },
    date: { type: 'string' },
  },
})
if (!values.dir || !values.tag || !values.repo) {
  console.error(
    '用法：node scripts/update-manifest.mjs --dir <目录> --tag v<版本> --repo <owner/name>',
  )
  process.exit(2)
}
const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(values.tag)
if (!match) {
  console.error(`标签要是 v<主>.<次>.<修订>，给的是 ${values.tag}`)
  process.exit(2)
}
const version = values.tag.slice(1)
const [major, minor, patch] = match.slice(1).map(Number)
// 和 apps/mobile/plugins/release-signing.js 的算法一致
const versionCode = major * 1_000_000 + minor * 1_000 + patch
const base = `https://github.com/${values.repo}/releases/download/${values.tag}`
const pubDate = values.date ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

function asset(name, extra = {}) {
  const path = join(values.dir, name)
  const bytes = readFileSync(path)
  return {
    url: `${base}/${name}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: statSync(path).size,
    ...extra,
  }
}

const mac = asset(`Litch-${version}-macos-arm64.zip`)
const manifest = {
  version,
  pubDate,
  notesUrl: `https://github.com/${values.repo}/releases/tag/${values.tag}`,
  assets: {
    'macos-arm64': mac,
    'windows-x64': asset(`Litch-${version}-windows-x64-setup.exe`),
    'android-arm64': asset(`Litch-${version}-android-arm64.apk`, { versionCode }),
  },
  // 给 macOS 上 Electron 自带的更新器（Squirrel.Mac 的 JSON 格式）读
  currentRelease: version,
  releases: [
    {
      version,
      updateTo: { version, name: `Litch ${version}`, notes: '', pub_date: pubDate, url: mac.url },
    },
  ],
}
const out = join(values.dir, 'litch-update.json')
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(readFileSync(out, 'utf8'))
