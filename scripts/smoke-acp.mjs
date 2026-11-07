// 真实 ACP CLI + 回环假模型。CLI 只装到本工作树的隔离前缀，版本唯一来源是 protocol/versions.json。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pinned = JSON.parse(readFileSync(join(repo, 'protocol/versions.json'), 'utf8')).acpSmoke
const home = mkdtempSync(join(tmpdir(), 'litch-acp-install-'))
// 安装不继承个人 npm 配置、模型凭据或主目录；测试里的每个 agent 再单独隔离 HOME/XDG。
const env = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_CACHE_HOME: join(home, 'cache'),
  XDG_DATA_HOME: join(home, 'data'),
  XDG_STATE_HOME: join(home, 'state'),
  npm_config_userconfig: join(home, '.npmrc'),
  npm_config_cache: join(repo, '.artifacts/npm-cache'),
}

try {
  for (const [id, pkg] of [
    ['gemini', '@google/gemini-cli'],
    ['opencode', 'opencode-ai'],
  ]) {
    const version = pinned[id]
    assert.match(version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/, `${id} 必须锁定精确版本`)
    const prefix = join(repo, `.artifacts/acp-smoke-${id}`)
    mkdirSync(prefix, { recursive: true })
    const manifest = join(prefix, 'node_modules', pkg, 'package.json')
    let installed
    try {
      installed = JSON.parse(readFileSync(manifest, 'utf8')).version
    } catch {}
    if (installed !== version) {
      execFileSync(
        'npm',
        [
          'install',
          '--prefix',
          prefix,
          '--save-exact',
          `${pkg}@${version}`,
          '--no-audit',
          '--no-fund',
        ],
        { cwd: repo, env, stdio: 'inherit' },
      )
    }
    assert.equal(JSON.parse(readFileSync(manifest, 'utf8')).version, version)
    env[`LITCH_SMOKE_${id.toUpperCase()}`] = join(prefix, 'node_modules/.bin', id)
    console.log(`ACP 冒烟：${pkg}@${version}`)
  }
  execFileSync(process.execPath, ['--test', 'packages/acp/dist/acp/test/smoke.test.mjs'], {
    cwd: repo,
    env,
    stdio: 'inherit',
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}
