// 原样同步 magpie helper 的包闭包；不从分支名解析版本、不覆盖本地修改。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../third_party/magpie/', import.meta.url))
const manifestPath = join(root, 'UPSTREAM.json')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const previous = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null
if (previous) {
  for (const entry of readdirSync(root, { recursive: true })) {
    const path = String(entry).replaceAll('\\', '/')
    if (
      statSync(join(root, path)).isFile() &&
      !['UPSTREAM.json', 'PATCHES.md'].includes(path) &&
      !(path in previous.files)
    )
      throw new Error(`上游镜像有清单之外的文件：${path}`)
  }
  for (const [path, expected] of Object.entries(previous.files)) {
    if (!existsSync(join(root, path)) || hash(readFileSync(join(root, path))) !== expected)
      throw new Error(`上游镜像已被修改，拒绝覆盖：${path}`)
  }
}
if (process.argv[2] === '--check') {
  if (!previous) throw new Error('没有 UPSTREAM.json')
  console.log(`magpie ${previous.commit}：${Object.keys(previous.files).length} 个文件原文一致`)
} else {
  const [source, commit] = process.argv.slice(2)
  if (!source || !/^[a-f0-9]{40}$/.test(commit ?? ''))
    throw new Error('用法：node scripts/sync-magpie-tui.mjs <上游本地仓库> <完整提交号> | --check')
  const git = (...args) =>
    execFileSync('git', ['-C', source, ...args], { maxBuffer: 64 * 1024 * 1024 })
  const paths = git('ls-tree', '-r', '--name-only', commit).toString().trim().split('\n')
  const packages = new Set(['claudetui'])
  // 包测试也是镜像的一部分，因此把测试引用的内部包一并整包纳入。
  for (const name of packages) {
    for (const path of paths.filter(
      (path) => path.startsWith(`internal/${name}/`) && path.endsWith('.go'),
    )) {
      const content = git('show', `${commit}:${path}`).toString()
      for (const match of content.matchAll(/"github\.com\/yetone\/magpie\/internal\/([^"/]+)"/g))
        packages.add(match[1])
    }
  }
  const selected = paths.filter(
    (path) =>
      ['LICENSE', 'THIRD_PARTY_NOTICES', 'go.mod', 'go.sum'].includes(path) ||
      [...packages].some((name) => path.startsWith(`internal/${name}/`)),
  )
  const content = new Map(selected.map((path) => [path, git('show', `${commit}:${path}`)]))
  for (const license of ['LICENSE', 'THIRD_PARTY_NOTICES']) {
    if (previous && hash(content.get(license)) !== previous.files[license])
      throw new Error(`许可证发生变化，先人工审查：${license}`)
  }
  // 删除文件需要单独审查；同步器本身不做删除操作。
  for (const path of Object.keys(previous?.files ?? {}))
    if (!content.has(path)) throw new Error(`上游删除了 ${path}，请先人工审查`)
  for (const [path, bytes] of content) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), bytes)
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        repository: 'https://github.com/yetone/magpie',
        commit,
        packages: [...packages].sort(),
        files: Object.fromEntries([...content].map(([path, bytes]) => [path, hash(bytes)])),
      },
      null,
      2,
    )}\n`,
  )
  console.log(`已原样同步 ${content.size} 个文件，${packages.size} 个整包`)
}
