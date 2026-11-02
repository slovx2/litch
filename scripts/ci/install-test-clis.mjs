// CI 隔离 CLI 的精确基线；不安装到全局或个人 HOME。普通用户的版本下限不由此决定。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkPlan } from './check-catalog.mjs'

export function cliPackages(versions) {
  const specs = {
    CODEX: {
      name: '@openai/codex',
      version: versions.codexVerified[0],
      prefix: '.artifacts/host-codex',
      binary: 'codex',
    },
    // 保持原 CI/Full 的2.1.282基线；protocol.claudeCli为另一个TUI专项版本，不能混用。
    CLAUDE: {
      name: '@anthropic-ai/claude-code',
      version: '2.1.282',
      prefix: '.artifacts/host-cli',
      binary: 'claude',
    },
    DSH: {
      name: '@deepseek-ai/dsh',
      version: versions.dshMinimum,
      prefix: '.artifacts/host-dsh',
      binary: 'dsh',
    },
    OPENCODE: {
      name: 'opencode-ai',
      version: versions.opencodeVerified[0],
      prefix: '.artifacts/host-opencode',
      binary: 'opencode',
    },
  }
  for (const spec of Object.values(specs))
    assert.match(spec.version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/, 'CLI必须为精确版本')
  return { ...specs, ACP: specs.OPENCODE }
}

export function cliInventory(names, versions, env = process.env) {
  const specs = cliPackages(versions)
  return names.map((name) => {
    const spec = specs[name]
    const binary = resolve(spec.prefix, 'node_modules/.bin', spec.binary)
    assert.equal(env[`CHA_${name}_CLI`], binary, `CLI不属于本次隔离前缀：${name}`)
    const pkg = JSON.parse(
      readFileSync(resolve(spec.prefix, 'node_modules', spec.name, 'package.json')),
    )
    assert.equal(pkg.version, spec.version, `CLI版本不同：${name}`)
    return { id: name, package: spec.name, version: pkg.version }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.env.GITHUB_ENV, '只用于CI，必须提供GITHUB_ENV')
  const plan = checkPlan(process.argv.slice(2))
  const specs = cliPackages(JSON.parse(readFileSync('protocol/versions.json')))
  const installed = new Set()
  for (const name of plan.clis) {
    const spec = specs[name]
    if (!installed.has(spec.prefix)) {
      execFileSync(
        'npm',
        [
          'install',
          '--prefix',
          spec.prefix,
          '--save-exact',
          `${spec.name}@${spec.version}`,
          '--no-audit',
          '--no-fund',
        ],
        { stdio: 'inherit' },
      )
      installed.add(spec.prefix)
    }
    const binary = resolve(spec.prefix, 'node_modules/.bin', spec.binary)
    assert.ok(!/[\r\n]/.test(binary))
    appendFileSync(process.env.GITHUB_ENV, `CHA_${name}_CLI=${binary}\n`)
  }
}
