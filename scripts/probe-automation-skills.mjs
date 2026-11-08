// 真实 CLI 的无模型发现探针。可打成单文件在远端隔离运行；不读个人 HOME。
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { query } from '../packages/claude/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'
import { installSharedAutomationSkills } from '../packages/device/dist/shared/src/automation-skills.mjs'

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((v, i, a) => (i % 2 === 0 ? [v, a[i + 1]] : null))
    .filter(Boolean),
)
const home = realpathSync(mkdtempSync(join(tmpdir(), 'litch-skill-discovery-')))
const env = {
  PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  HOME: home,
  CODEX_HOME: join(home, '.codex'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  TMPDIR: home,
  ANTHROPIC_API_KEY: 'isolated-skill-discovery',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  HTTP_PROXY: 'http://127.0.0.1:1',
  HTTPS_PROXY: 'http://127.0.0.1:1',
  NO_PROXY: '127.0.0.1,localhost',
}
for (const dir of [env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) mkdirSync(dir, { recursive: true })
const children = []
const report = {}
function rpc(binary) {
  const child = spawn(binary, ['app-server', '-c', 'features.plugins=false'], {
    cwd: home,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  let id = 0
  const pending = new Map()
  let errors = ''
  child.stderr.on('data', (c) => (errors += c))
  createInterface({ input: child.stdout }).on('line', (line) => {
    let m
    try {
      m = JSON.parse(line)
    } catch {
      return
    }
    const p = pending.get(m.id)
    if (p) {
      pending.delete(m.id)
      clearTimeout(p.timer)
      m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result)
    }
  })
  child.on('exit', () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.reject(Error(errors.slice(-1000)))
    }
    pending.clear()
  })
  return {
    child,
    ask: (method, params) =>
      new Promise((resolve, reject) => {
        const k = ++id,
          timer = setTimeout(() => {
            pending.delete(k)
            reject(Error(`${method}: timeout`))
          }, 30000)
        pending.set(k, { resolve, reject, timer })
        child.stdin.write(JSON.stringify({ id: k, method, params }) + '\n')
      }),
  }
}
try {
  assert.equal(installSharedAutomationSkills(home).length, 4)
  if (args['--codex']) {
    const native = rpc(args['--codex'])
    await native.ask('initialize', {
      clientInfo: { name: 'litch-skills-probe', version: '1' },
      capabilities: { experimentalApi: true },
    })
    native.child.stdin.write('{"method":"initialized"}\n')
    const result = await native.ask('skills/list', { cwds: [home], forceReload: true })
    assert.ok(result.data.every((row) => !row.errors?.length))
    const found = result.data
      .flatMap((row) => row.skills)
      .filter((s) => s.name.startsWith('litch-'))
    for (const name of ['litch-browser-automation', 'litch-computer-automation'])
      assert.ok(
        found.some(
          (s) => s.name === name && s.enabled !== false && s.path.includes('/.agents/skills/'),
        ),
      )
    report.codex = {
      version: execFileSync(args['--codex'], ['--version'], { env, encoding: 'utf8' }).trim(),
      skills: found.map((s) => ({ name: s.name, path: s.path, enabled: s.enabled })),
    }
  }
  if (args['--claude']) {
    let release
    const waiting = new Promise((r) => (release = r))
    const q = query({
      prompt: (async function* () {
        await waiting
      })(),
      options: {
        cwd: home,
        env,
        pathToClaudeCodeExecutable: args['--claude'],
        settingSources: ['user'],
        persistSession: false,
        spawnClaudeCodeProcess(options) {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ['pipe', 'pipe', 'pipe'],
          })
          children.push(child)
          return child
        },
      },
    })
    try {
      const commands = await q.supportedCommands()
      for (const name of ['litch-browser-automation', 'litch-computer-automation'])
        assert.ok(
          commands.some((c) => c.name === name),
          JSON.stringify(commands),
        )
      report.claude = {
        version: execFileSync(args['--claude'], ['--version'], { env, encoding: 'utf8' }).trim(),
        skills: commands.filter((c) => c.name.startsWith('litch-')).map((c) => c.name),
      }
    } finally {
      q.close()
      release()
    }
  }
  report.passed = true
  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const child of children) child.kill('SIGTERM')
  await Promise.all(
    children.map((c) =>
      c.exitCode !== null
        ? null
        : new Promise((r) => {
            c.once('exit', r)
            setTimeout(() => {
              c.kill('SIGKILL')
              r()
            }, 2000).unref()
          }),
    ),
  )
  rmSync(home, { recursive: true, force: true })
}
