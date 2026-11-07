// 构建及真实 tarball 闭包检查；仓外 Node 消费者没有 Electron，也不依赖 Litch 目录。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { importsOf } from '../../../scripts/automation-boundary.mjs'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(packageDir, '../..')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const temp = mkdtempSync(join(tmpdir(), 'browser-package-'))
const home = join(temp, 'home'),
  consumer = join(temp, 'consumer')
mkdirSync(home)
mkdirSync(consumer)
const env = {
  ...process.env,
  HOME: home,
  CODEX_HOME: join(home, 'codex'),
  CLAUDE_CONFIG_DIR: join(home, 'claude'),
  CHA_STATE_DIR: join(home, 'adapter'),
  npm_config_cache: join(temp, 'npm-cache'),
  npm_config_userconfig: join(home, '.npmrc'),
}
const run = (file, args, cwd = root) =>
  execFileSync(file, args, { cwd, env, encoding: 'utf8', stdio: 'pipe' })
const tsc = join(root, 'node_modules/typescript/bin/tsc')
run(process.execPath, [tsc, '-p', join(packageDir, 'tsconfig.json')])
const source = join(packageDir, 'src')
for (const file of readdirSync(source, { recursive: true }).filter((file) =>
  file.endsWith('.mts'),
)) {
  const full = join(source, file)
  for (const specifier of importsOf(readFileSync(full, 'utf8'), full)) {
    if (isBuiltin(specifier) || specifier === 'electron') continue
    assert.ok(specifier.startsWith('.'), `未声明的依赖：${specifier}`)
    const target = resolve(dirname(full), specifier.replace(/\.mjs$/, '.mts'))
    assert.ok(
      target.startsWith(`${source}/`) ||
        target.startsWith(`${root}/packages/automation-contracts/src/`),
      `业务依赖越界：${target}`,
    )
    assert.ok(existsSync(target), `缺少源文件：${target}`)
  }
}
const npmCli = process.env.npm_execpath
assert.ok(npmCli, '请使用 npm run check:package --prefix packages/browser')
const pack = JSON.parse(
  run(
    process.execPath,
    [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', temp],
    packageDir,
  ),
)[0]
const files = new Set(pack.files.map((one) => one.path))
assert.equal(manifest.private, true)
assert.equal(manifest.dependencies, undefined)
for (const file of files) {
  assert.match(file, /^(dist\/|native\/|README\.md$|LICENSE$|package\.json$)/)
  if (!/\.(mjs|mts)$/.test(file)) continue
  if (file.startsWith('dist/')) {
    const sourceFile = join(root, 'packages', file.slice(5).replace(/(?:\.d\.mts|\.mjs)$/, '.mts'))
    assert.ok(existsSync(sourceFile), `旧构建产物没有对应源文件：${file}`)
  }
  const full = join(packageDir, file)
  for (const specifier of importsOf(readFileSync(full, 'utf8'), full)) {
    if (isBuiltin(specifier) || specifier === 'electron') continue
    assert.ok(specifier.startsWith('.'), `产物存在未声明依赖：${specifier}`)
    const target = relative(packageDir, resolve(dirname(full), specifier)).replaceAll('\\', '/')
    assert.ok(
      files.has(target) ||
        (file.endsWith('.d.mts') && files.has(target.replace(/\.mjs$/, '.d.mts'))),
      `tarball 缺依赖：${target}`,
    )
  }
}
for (const file of ['addon.c', 'keychain.c', 'keychain.h', 'keychain-helper.mjs', 'build.mjs'])
  assert.ok(files.has(`native/${file}`))
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
run(
  process.execPath,
  [
    npmCli,
    'install',
    join(temp, pack.filename),
    '--ignore-scripts',
    '--offline',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
  ],
  consumer,
)
const example = readFileSync(join(packageDir, 'examples/node-host.mts'), 'utf8')
writeFileSync(
  join(consumer, 'host.mts'),
  example
    .replaceAll("'../src/index.mjs'", JSON.stringify(manifest.name))
    .replaceAll("'../src/import.mjs'", JSON.stringify(`${manifest.name}/import`)),
)
run(
  process.execPath,
  [
    tsc,
    'host.mts',
    '--module',
    'NodeNext',
    '--target',
    'ES2023',
    '--strict',
    '--types',
    'node',
    '--typeRoots',
    join(root, 'node_modules/@types'),
    '--outDir',
    'out',
  ],
  consumer,
)
const output = run(process.execPath, ['out/host.mjs'], consumer)
assert.match(output, /独立 Node 宿主通过/)
// 网页入口不能从默认 Node 工具入口绕入 fs/crypto 或 Electron。
await build({
  stdin: {
    contents: `import { createAutomationPointer } from '${manifest.name}/pointer-renderer'; globalThis.fixturePointer = createAutomationPointer;`,
    resolveDir: consumer,
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome125',
  write: false,
})
console.log(JSON.stringify({ ok: true, files: files.size, consumer, output: output.trim() }))
