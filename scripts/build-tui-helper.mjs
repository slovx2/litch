// 原样 magpie helper 的六平台产物；只在外部模块加入口，不改第三方镜像。
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const cwd = join(repo, 'cmd/claude-tui-helper')
const out = join(repo, 'packages/claude/dist/claude/src/tui-helper')
const targets = [
  'linux-amd64',
  'linux-arm64',
  'darwin-amd64',
  'darwin-arm64',
  'windows-amd64',
  'windows-arm64',
]
const modules = new Map()
execFileSync(process.execPath, [join(repo, 'scripts/sync-magpie-tui.mjs'), '--check'], {
  stdio: 'inherit',
})
for (const target of targets) {
  const [GOOS, GOARCH] = target.split('-')
  const rows = execFileSync(
    'go',
    [
      'list',
      '-deps',
      '-f',
      '{{if .Module}}{{.Module.Path}}|{{.Module.Dir}}|{{.Module.Version}}{{end}}',
      '.',
    ],
    {
      cwd,
      env: { ...process.env, GOOS, GOARCH, CGO_ENABLED: '0' },
      encoding: 'utf8',
    },
  )
  for (const row of rows.trim().split('\n').filter(Boolean)) {
    const [path, dir, version] = row.split('|')
    if (path !== 'github.com/yetone/magpie/litch') modules.set(path, { dir, version })
  }
}
const licenses = join(out, 'licenses')
mkdirSync(licenses, { recursive: true })
for (const [path, { dir }] of modules) {
  const target = join(licenses, path)
  mkdirSync(target, { recursive: true })
  const files = readdirSync(dir).filter((name) =>
    /^(LICENSE|LICENCE|COPYING|NOTICE|THIRD_PARTY_NOTICES|AUTHORS)([.\-_]|$)/i.test(name),
  )
  if (files.length === 0) throw new Error(`依赖没有许可材料：${path}`)
  for (const name of files) cpSync(join(dir, name), join(target, name), { recursive: true })
}
const goroot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim()
cpSync(join(goroot, 'LICENSE'), join(licenses, 'GO-LICENSE'))
cpSync(join(repo, 'third_party/magpie/UPSTREAM.json'), join(licenses, 'UPSTREAM.json'))
writeFileSync(
  join(licenses, 'MODULES.json'),
  `${JSON.stringify(Object.fromEntries([...modules].map(([path, value]) => [path, value.version])), null, 2)}\n`,
)
await Promise.all(
  targets.map(
    (target) =>
      new Promise((resolve, reject) => {
        const [GOOS, GOARCH] = target.split('-')
        const binary = join(out, target, `claude-tui-helper${GOOS === 'windows' ? '.exe' : ''}`)
        const child = spawn(
          'go',
          ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', binary, '.'],
          {
            cwd,
            env: { ...process.env, GOOS, GOARCH, CGO_ENABLED: '0' },
            stdio: ['ignore', 'inherit', 'inherit'],
          },
        )
        child.once('error', reject)
        child.once('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`${target} TUI helper 编译失败`)),
        )
      }),
  ),
)
