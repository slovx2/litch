// 用真正的 Git 检出验证字节完整性，不在哈希校验中掩盖 CRLF 转换。
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))

test('autocrlf=true 检出仍保持 magpie 全量原始字节，校验拒绝人为换行转换', () => {
  const home = mkdtempSync(join(tmpdir(), 'magpie-checkout-'))
  const source = join(home, 'source')
  const checkout = join(home, 'checkout')
  const env = Object.fromEntries(
    ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP']
      .filter((key) => process.env[key] != null)
      .map((key) => [key, process.env[key]]),
  )
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
  })
  writeFileSync(env.GIT_CONFIG_GLOBAL, '')
  const git = (cwd, args) => execFileSync('git', args, { cwd, env, stdio: 'pipe' })
  try {
    mkdirSync(join(source, 'scripts'), { recursive: true })
    cpSync(join(repo, 'third_party/magpie'), join(source, 'third_party/magpie'), {
      recursive: true,
    })
    cpSync(join(repo, '.gitattributes'), join(source, '.gitattributes'))
    cpSync(join(repo, 'scripts/sync-magpie-tui.mjs'), join(source, 'scripts/sync-magpie-tui.mjs'))
    git(source, ['init', '-q'])
    git(source, ['-c', 'core.autocrlf=false', 'add', '.'])
    git(source, [
      '-c',
      'user.name=fixture',
      '-c',
      'user.email=fixture@invalid',
      'commit',
      '-qm',
      'fixture',
    ])
    git(home, ['clone', '-q', '--no-hardlinks', '-c', 'core.autocrlf=true', source, checkout])
    assert.equal(git(checkout, ['config', '--get', 'core.autocrlf']).toString().trim(), 'true')
    const check = () =>
      spawnSync(process.execPath, ['scripts/sync-magpie-tui.mjs', '--check'], {
        cwd: checkout,
        env,
        encoding: 'utf8',
      })
    const intact = check()
    assert.equal(intact.status, 0, intact.stderr)
    const license = join(checkout, 'third_party/magpie/LICENSE')
    assert.deepEqual(readFileSync(license), readFileSync(join(repo, 'third_party/magpie/LICENSE')))
    // 显式制造原失败：即使只改行尾，也必须报原样镜像被修改。
    writeFileSync(license, readFileSync(license, 'utf8').replaceAll('\n', '\r\n'))
    const changed = check()
    assert.notEqual(changed.status, 0)
    assert.match(changed.stderr, /上游镜像已被修改，拒绝覆盖：LICENSE/)
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
