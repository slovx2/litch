// 日常入口：缺依赖时只安装锁文件里的桌面构建依赖；浏览器固定版本缓存到本工作树。
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, globSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const started = Date.now()
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const chromeVersion = '151.0.7922.34'
if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 24)
  throw new Error('Chrome acceptance requires macOS and Node 24 or newer.')
const base = join(root, '.local/chrome-e2e-bootstrap')
mkdirSync(base, { recursive: true })
if (!existsSync(join(root, 'apps/desktop/node_modules/esbuild/package.json'))) {
  const home = mkdtempSync(join(tmpdir(), 'litch-chrome-deps-'))
  try {
    execFileSync(
      join(dirname(process.execPath), 'npm'),
      ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', join(root, 'apps/desktop')],
      {
        stdio: 'inherit',
        env: {
          PATH: process.env.PATH,
          HOME: home,
          npm_config_userconfig: '/dev/null',
          npm_config_cache: join(base, 'npm-cache'),
        },
      },
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
const architecture = process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
const executable = `chrome-${architecture}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`
let binary =
  process.env.LITCH_CHROME_BINARY ??
  globSync(join(homedir(), `Library/Caches/ms-playwright/chromium-*/${executable}`))
    .sort()
    .at(-1)
if (!binary) {
  binary = join(base, chromeVersion, executable)
  if (!existsSync(binary)) {
    const directory = join(base, chromeVersion)
    mkdirSync(directory, { recursive: true })
    const archive = join(directory, 'chrome.zip')
    console.log(`Downloading isolated Chrome for Testing ${chromeVersion}`)
    const response = await fetch(
      `https://storage.googleapis.com/chrome-for-testing-public/${chromeVersion}/${architecture}/chrome-${architecture}.zip`,
    )
    if (!response.ok) throw new Error(`Chrome download failed: HTTP ${response.status}`)
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()))
    execFileSync('/usr/bin/ditto', ['-xk', archive, directory])
    rmSync(archive)
  }
}
const passed = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      [
        'PATH',
        'TMPDIR',
        'LANG',
        'LITCH_SSH_CONFIG',
        'LITCH_REMOTE_ADAPTER',
        'LITCH_REMOTE_CODEX',
        'LITCH_CHECK_DEBUG',
      ].includes(name) || name.startsWith('LITCH_CHROME_'),
  ),
)
const runtimeHome = mkdtempSync(join(tmpdir(), 'litch-chrome-run-home-'))
// 同一进程组的子脚本会先收信号并清理；等它退出后再清理这一层的 HOME。
process.once('SIGINT', () => {})
process.once('SIGTERM', () => {})
const result = spawnSync(
  process.execPath,
  [join(root, 'scripts/chrome-e2e/run.mjs'), ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...passed,
      HOME: runtimeHome,
      CODEX_HOME: join(runtimeHome, '.codex'),
      GOCACHE: join(base, 'go-build'),
      GOMODCACHE: join(base, 'go-mod'),
      LITCH_CHROME_BINARY: binary,
    },
  },
)
rmSync(runtimeHome, { recursive: true, force: true })
console.log(`Chrome acceptance total including preparation: ${Date.now() - started} ms`)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
