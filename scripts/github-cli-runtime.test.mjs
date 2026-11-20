import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  GITHUB_CLI_VERSION,
  githubCliArchive,
  githubCliChecksum,
  installGithubCliArchive,
} from './github-cli-runtime.mjs'

test('固定版本归档经清单校验后才进受管路径', { skip: process.platform === 'win32' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lg-archive-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const targets = [
    ['linux', 'x64'],
    ['darwin', 'arm64'],
    ['win32', 'x64'],
  ]
  for (const [platform, arch] of targets) {
    const filename = githubCliArchive(platform, arch)
    const archive = join(dir, filename)
    const dirname = filename.replace(/\.(?:zip|tar\.gz)$/, '')
    const binaryName = platform === 'win32' ? 'gh.exe' : 'gh'
    const folder = join(dir, dirname)
    mkdirSync(join(folder, 'bin'), { recursive: true })
    writeFileSync(join(folder, 'bin', binaryName), platform)
    writeFileSync(join(folder, 'LICENSE'), 'mock license\n')
    if (platform === 'linux') execFileSync('tar', ['-czf', archive, '-C', dir, dirname])
    else execFileSync('zip', ['-q', '-r', archive, dirname], { cwd: dir })
    const sha = createHash('sha256').update(readFileSync(archive)).digest('hex')
    const line = `${sha}  ${filename}\n`
    const expected = githubCliChecksum(line, filename)
    assert.throws(() => githubCliChecksum(line + line, filename), /唯一/)
    const root = join(dir, 'adapter')
    const read = { platform, arch, archive, expected }
    await assert.rejects(
      installGithubCliArchive(root, { ...read, expected: 'a'.repeat(64) }),
      /SHA-256/,
    )
    const path = join(root, 'tools', 'github-cli', GITHUB_CLI_VERSION, `${platform}-${arch}`)
    assert.equal(existsSync(path), false)
    assert.equal(await installGithubCliArchive(root, read), join(path, 'bin', binaryName))
    assert.equal(readFileSync(join(path, 'bin', binaryName), 'utf8'), platform)
    assert.equal(readFileSync(join(path, 'LICENSE'), 'utf8'), 'mock license\n')
  }
})
