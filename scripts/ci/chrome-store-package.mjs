// 从检出的发版提交构建商店包；比较交付文件，忽略 ZIP 容器和 manifest.version。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const itemId = 'ddnllmibgnhhiiaaidfamlknbnfjpnpo'
export const receiptName = 'chrome-store-package.json'
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    )
  return value
}

export function contentHash(files) {
  const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return hash(
    JSON.stringify(
      entries.map(([name, bytes]) => {
        if (name === 'manifest.json') {
          const manifest = JSON.parse(bytes.toString())
          delete manifest.version
          bytes = Buffer.from(JSON.stringify(canonical(manifest)))
        }
        return [name, hash(bytes)]
      }),
    ),
  )
}

export async function deliveryFiles(directory, prefix = '') {
  const files = {}
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const name = prefix + entry.name
    assert.ok(!entry.isSymbolicLink(), '商店包不能有符号链接')
    if (entry.isDirectory()) Object.assign(files, await deliveryFiles(directory, `${name}/`))
    else {
      assert.ok(entry.isFile(), '商店包只能有普通文件')
      files[name] = await readFile(join(directory, name))
    }
  }
  return files
}

export async function packageStore(source, output, sha) {
  assert.match(sha ?? '', /^[a-f0-9]{40}$/, '候选 SHA')
  source = resolve(source)
  output = resolve(output)
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
    sha,
  )
  assert.equal(
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: source,
      encoding: 'utf8',
    }).trim(),
    '',
    '候选源码有未提交修改，不能冒充指定提交的商店包',
  )
  // 输出目录必须全新，防止旧资源混进 ZIP。
  await mkdir(output)
  const directory = join(output, 'extension')
  const buildUrl = pathToFileURL(join(source, 'apps/desktop/scripts/build-chrome.mjs')).href
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const {buildChromeExtension} = await import(${JSON.stringify(buildUrl)}); await buildChromeExtension(${JSON.stringify(directory)});`,
    ],
    { cwd: source, stdio: 'pipe' },
  )
  const manifestPath = join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const version = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')).version
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.equal(manifest.version, version)
  delete manifest.key
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await rm(join(directory, 'identity.json'))
  const files = await deliveryFiles(directory)
  assert.ok(!Object.keys(files).some((name) => /(?:^|\/)(?:identity\.json|.*\.pem)$/.test(name)))
  const zipName = `litch-browser-${version}.zip`
  execFileSync('zip', ['-X', '-q', join(output, zipName), ...Object.keys(files).sort()], {
    cwd: directory,
    stdio: 'pipe',
  })
  const receipt = {
    schema: 1,
    itemId,
    version,
    sha,
    contentHash: contentHash(files),
    zipName,
    zipSha256: hash(await readFile(join(output, zipName))),
  }
  await writeFile(join(output, receiptName), `${JSON.stringify(receipt, null, 2)}\n`)
  return receipt
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await packageStore(process.argv[2], process.argv[3], process.env.CANDIDATE_SHA)
