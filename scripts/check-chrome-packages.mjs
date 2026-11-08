// 真 tarball 装进仓外消费者；禁用 lifecycle，不靠仓库 node_modules 补漏。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = join(root, '.artifacts/chrome-packages')
await mkdir(output, { recursive: true })
const work = await mkdtemp(join(tmpdir(), 'chrome-sdk-consumer-'))
const consumer = join(work, 'consumer'),
  home = join(work, 'home')
await mkdir(consumer)
await mkdir(home)
const npm = join(dirname(process.execPath), 'npm')
const env = {
  PATH: process.env.PATH,
  HOME: home,
  CODEX_HOME: join(home, 'codex'),
  CLAUDE_CONFIG_DIR: join(home, 'claude'),
  npm_config_userconfig: '/dev/null',
  npm_config_cache: process.env.npm_config_cache ?? join(process.env.HOME, '.npm'),
}
const artifacts = []
for (const name of ['chrome-bridge', 'chrome-extension']) {
  const pkg = join(root, 'packages', name)
  execFileSync(npm, ['run', 'build'], { cwd: pkg, env, stdio: 'pipe' })
  const result = JSON.parse(
    execFileSync(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', output], {
      cwd: pkg,
      env,
      encoding: 'utf8',
    }),
  )[0]
  assert.ok(result.files.every((file) => !file.path.startsWith('src/')))
  const file = join(output, result.filename)
  artifacts.push({
    file,
    sha256: createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
  })
}
await writeFile(
  join(consumer, 'package.json'),
  JSON.stringify({ name: 'isolated-consumer', private: true, type: 'module' }),
)
execFileSync(
  npm,
  [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--save-exact',
    ...artifacts.map((item) => item.file),
  ],
  { cwd: consumer, env, stdio: 'pipe' },
)
const probe = `
import assert from 'node:assert/strict';
import { ChromeBridge, createChromeExecutor, chromeToolsSpec } from '@litch/chrome-bridge';
import { createExtensionRuntime } from '@litch/chrome-extension';
import { installPointerWorld } from '@litch/chrome-extension/pointer-world';
import { extensionId, assembleExtension } from '@litch/chrome-extension/build';
assert.equal(typeof ChromeBridge, 'function'); assert.equal(typeof createChromeExecutor, 'function');
assert.equal(chromeToolsSpec('example_browser', 'Example').name, 'example_browser');
assert.equal(typeof installPointerWorld, 'function'); assert.equal(typeof assembleExtension, 'function');
assert.equal(extensionId(Buffer.from('fixture').toString('base64')).length, 32);
const runtime = createExtensionRuntime({ chrome: {}, identity: { hostName:'example.chrome', extensionIds:['a'.repeat(32)], productName:'Example' }, protocol:{min:1,max:1}, storagePrefix:'fixture', pointerSource:'' });
await runtime.stop();
console.log('仓外 Node 导入通过；无 Electron、无 import 连接/登记副作用');
`
execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
  cwd: consumer,
  env,
  stdio: 'inherit',
})
// 所有相对依赖必须仍落在安装后的包内；类型和运行时不依赖 apps/core/UI/protocol。
for (const name of ['chrome-bridge', 'chrome-extension']) {
  const pkg = join(consumer, 'node_modules', `@litch/${name}`)
  for (const entry of await readdir(join(pkg, 'dist'), { recursive: true })) {
    if (!/\.m[jt]s$/.test(entry)) continue
    const source = await readFile(join(pkg, 'dist', entry), 'utf8')
    for (const match of source.matchAll(/(?:from\s+|import\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1]
      assert.ok(
        !specifier.includes('@litch/') &&
          !specifier.includes('/protocol/') &&
          !specifier.includes('/core/') &&
          !specifier.includes('/ui/'),
      )
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(join(pkg, 'dist', entry)), specifier)
        assert.ok(target.startsWith(`${pkg}/dist/`), target)
      }
    }
  }
}
await writeFile(
  join(output, 'report.json'),
  `${JSON.stringify({ consumer, artifacts, success: true }, null, 2)}\n`,
)
console.log(JSON.stringify({ consumer, artifacts, success: true }))
