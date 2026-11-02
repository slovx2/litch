// 原样 magpie helper 的六平台产物；只在外部模块加入口，不改第三方镜像。
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
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
// 每次重建：旧产物里可能留着只读的许可文件，直接覆盖会失败
rmSync(licenses, { recursive: true, force: true })
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
// 官方发行包的许可在 GOROOT 下；Homebrew 的 go 以 <keg>/libexec 为 GOROOT，许可在 keg 根目录
const goLicenses = [join(goroot, 'LICENSE')]
if (basename(goroot) === 'libexec') goLicenses.push(join(dirname(goroot), 'LICENSE'))
const goLicense = goLicenses.find((path) => existsSync(path))
if (!goLicense) throw new Error(`找不到 Go 的许可文件，查过：${goLicenses.join('、')}`)
cpSync(goLicense, join(licenses, 'GO-LICENSE'))
cpSync(join(repo, 'third_party/magpie/UPSTREAM.json'), join(licenses, 'UPSTREAM.json'))
// Go 模块缓存里的文件是只读的，cpSync 会把权限原样带过来；应用里留着只读文件，
// Squirrel.Mac（ShipIt）安装更新时改不了它们的扩展属性，更新就装不上。统一成文件 0644、目录 0755
chmodSync(licenses, 0o755)
for (const entry of readdirSync(licenses, { recursive: true, withFileTypes: true }))
  chmodSync(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o755 : 0o644)
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
